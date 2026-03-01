import {
  ConnectionClosedError,
  DisposedError,
  SocketClientError,
  TimeoutError,
  ValidationError,
} from "./errors";
import type {
  AckKey,
  ConnectionState,
  Envelope,
  EventHandler,
  PendingAck,
  PayloadType,
  PublishOptions,
  SocketClientEvents,
  SocketClientOptions,
} from "./types";

const DEFAULT_OPTIONS: Omit<SocketClientOptions, "url"> = {
  connectTimeoutMs: 8000,
  ackTimeoutMs: 5000,
  retry: {
    enabled: true,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    factor: 1.8,
    maxRetries: 30,
    jitter: 0.25,
  },
  queue: {
    maxSize: 200,
    dropPolicy: "oldest",
  },
  logger: console,
};

export class SocketClient {
  private readonly options: SocketClientOptions;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private disposed = false;
  private userClosed = false;
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionNonce = 0;

  private readonly listeners = new Map<
    keyof SocketClientEvents,
    Set<EventHandler<unknown>>
  >();

  private readonly desiredRooms = new Set<string>();
  private readonly activeRooms = new Set<string>();
  private readonly pendingAcks = new Map<AckKey, PendingAck[]>();
  private readonly queuedPublishes: Envelope[] = [];

  constructor(
    input: Partial<SocketClientOptions> & Pick<SocketClientOptions, "url">,
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...input,
      retry: { ...DEFAULT_OPTIONS.retry, ...input.retry },
      queue: { ...DEFAULT_OPTIONS.queue, ...input.queue },
      logger: input.logger ?? DEFAULT_OPTIONS.logger,
    };

    this.validateUrl(this.options.url);
    this.validateOptions();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  on<K extends keyof SocketClientEvents>(
    event: K,
    handler: EventHandler<SocketClientEvents[K]>,
  ): () => void {
    const set = this.listeners.get(event) ?? new Set<EventHandler<unknown>>();
    set.add(handler as EventHandler<unknown>);
    this.listeners.set(event, set);
    return () => this.off(event, handler);
  }

  off<K extends keyof SocketClientEvents>(
    event: K,
    handler: EventHandler<SocketClientEvents[K]>,
  ): void {
    this.listeners.get(event)?.delete(handler as EventHandler<unknown>);
  }

  async connect(): Promise<void> {
    this.assertNotDisposed();
    if (this.state === "open") return;
    if (this.connectPromise) return this.connectPromise;

    this.userClosed = false;
    this.setState("connecting");

    const nonce = ++this.connectionNonce;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        const ws = new WebSocket(this.options.url, this.options.protocols);
        this.ws = ws;

        this.connectTimer = setTimeout(() => {
          this.failConnect(new TimeoutError("Connection timed out"));
          this.safeCloseSocket(4000, "connect_timeout");
        }, this.options.connectTimeoutMs);

        ws.onopen = () => {
          if (nonce !== this.connectionNonce) {
            this.safeCloseSocket(1000, "stale_connection");
            return;
          }

          this.clearConnectTimer();
          this.reconnectAttempts = 0;
          this.setState("open");
          this.emit("open", undefined);
          this.resolveConnect();
          void this.resubscribeAndFlush();
        };

        ws.onmessage = (event) => {
          if (nonce !== this.connectionNonce) return;
          this.handleMessage(event.data);
        };

        ws.onerror = () => {
          if (nonce !== this.connectionNonce) return;
          const error = new SocketClientError("WebSocket encountered an error");
          this.emit("error", error);
        };

        ws.onclose = (event) => {
          if (nonce !== this.connectionNonce) return;

          this.clearConnectTimer();
          this.ws = null;
          this.activeRooms.clear();
          this.rejectAllPendingAcks(new ConnectionClosedError());

          if (this.state !== "disposed") {
            this.setState(this.userClosed ? "closed" : "idle");
          }

          this.emit("close", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });

          if (!this.userClosed && !this.disposed) {
            this.scheduleReconnect();
          } else {
            this.rejectConnect(new ConnectionClosedError());
          }
        };
      } catch (error) {
        const wrapped = new SocketClientError("Failed to create WebSocket", {
          cause: error,
        });
        this.rejectConnect(wrapped);
        this.setState("closed");
      }
    });

    return this.connectPromise;
  }

  disconnect(code = 1000, reason = "client_disconnect"): void {
    if (this.disposed) return;
    this.userClosed = true;
    this.clearReconnectTimer();

    if (!this.ws || this.ws.readyState === 3) {
      this.setState("closed");
      return;
    }

    this.setState("closing");
    this.safeCloseSocket(code, reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.userClosed = true;

    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.rejectAllPendingAcks(new DisposedError());
    this.rejectConnect(new DisposedError());

    this.setState("disposed");
    this.safeCloseSocket(1000, "disposed");

    this.listeners.clear();
  }

  async subscribe(room: string, signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    this.assertRoom(room);
    this.desiredRooms.add(room);

    if (this.activeRooms.has(room) && this.state === "open") {
      return;
    }

    await this.connect();
    await this.sendWithAck(
      { type: "subscribe", room },
      room,
      "subscribe",
      signal,
    );
    this.activeRooms.add(room);
  }

  async unsubscribe(room: string, signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    this.assertRoom(room);

    this.desiredRooms.delete(room);
    if (this.state !== "open") {
      this.activeRooms.delete(room);
      return;
    }

    await this.sendWithAck(
      { type: "unsubscribe", room },
      room,
      "unsubscribe",
      signal,
    );
    this.activeRooms.delete(room);
  }

  async publish(
    room: string,
    event: string,
    payload: unknown,
    options: PublishOptions = {},
  ): Promise<void> {
    this.assertNotDisposed();
    this.assertRoom(room);
    this.assertNonEmpty(event, "event");

    const payloadType = options.payloadType ?? this.inferPayloadType(payload);
    const envelope: Envelope = {
      type: "publish",
      room,
      event,
      payloadType,
      payload: this.normalizePayloadForType(payload, payloadType),
    };

    if (this.state === "open") {
      this.sendRaw(envelope);
      return;
    }

    if (options.queueIfDisconnected) {
      this.enqueuePublish(envelope);
      if (this.state === "idle" || this.state === "closed") {
        void this.connect().catch((error) =>
          this.emit("error", error as Error),
        );
      }
      return;
    }

    throw new ConnectionClosedError();
  }

  private async sendWithAck(
    envelope: Envelope,
    room: string,
    action: "subscribe" | "unsubscribe",
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.state !== "open") {
      throw new ConnectionClosedError();
    }

    const ackPromise = this.waitForAck(room, action, signal);
    this.sendRaw(envelope);
    await ackPromise;
  }

  private waitForAck(
    room: string,
    action: "subscribe" | "unsubscribe",
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${action}:${room}` as AckKey;

    return new Promise<void>((resolve, reject) => {
      let ack: PendingAck | undefined;

      const onAbort = () => {
        cleanup();
        if (ack) this.removePendingAck(key, ack);
        reject(new SocketClientError(`${action} aborted`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        cleanup();
        if (ack) this.removePendingAck(key, ack);
        reject(new TimeoutError(`${action} ack timed out for room '${room}'`));
      }, this.options.ackTimeoutMs);

      if (signal?.aborted) {
        cleanup();
        reject(new SocketClientError(`${action} aborted`));
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });

      ack = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
        timer,
      };

      const existing = this.pendingAcks.get(key) ?? [];
      existing.push(ack);
      this.pendingAcks.set(key, existing);
    });
  }

  private removePendingAck(key: AckKey, ack: PendingAck): void {
    const list = this.pendingAcks.get(key);
    if (!list) return;
    const index = list.indexOf(ack);
    if (index >= 0) {
      list.splice(index, 1);
    }
    if (list.length === 0) {
      this.pendingAcks.delete(key);
    }
  }

  private resolvePendingAck(
    action: "subscribe" | "unsubscribe",
    room: string,
  ): void {
    const key = `${action}:${room}` as AckKey;
    const list = this.pendingAcks.get(key);
    if (!list || list.length === 0) return;

    const next = list.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.resolve();

    if (list.length === 0) {
      this.pendingAcks.delete(key);
    }
  }

  private rejectAllPendingAcks(error: Error): void {
    for (const [, list] of this.pendingAcks) {
      for (const pending of list) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
    this.pendingAcks.clear();
  }

  private async resubscribeAndFlush(): Promise<void> {
    if (this.state !== "open") return;

    for (const room of this.desiredRooms) {
      try {
        if (this.activeRooms.has(room)) continue;
        await this.sendWithAck({ type: "subscribe", room }, room, "subscribe");
        this.activeRooms.add(room);
      } catch (error) {
        this.options.logger?.warn?.(
          `failed to resubscribe room '${room}'`,
          error,
        );
      }
    }

    while (this.queuedPublishes.length > 0 && this.state === "open") {
      const next = this.queuedPublishes.shift();
      if (!next) break;
      this.sendRaw(next);
    }
  }

  private handleMessage(raw: string | ArrayBuffer | Blob): void {
    if (typeof raw !== "string") {
      this.emit(
        "error",
        new ValidationError("Server sent non-text frame; ignoring message"),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emit("error", new ValidationError("Server sent invalid JSON"));
      return;
    }

    const env = this.validateEnvelope(parsed);
    if (!env) return;

    if (env.type === "info" && env.room) {
      if (env.event === "subscribed") {
        this.activeRooms.add(env.room);
        this.resolvePendingAck("subscribe", env.room);
      }

      if (env.event === "unsubscribed") {
        this.activeRooms.delete(env.room);
        this.resolvePendingAck("unsubscribe", env.room);
      }
    }

    if (env.type === "error") {
      this.emit(
        "error",
        new SocketClientError(`Server error event '${env.event ?? "unknown"}'`),
      );
    }

    this.emit("message", env);
  }

  private validateEnvelope(input: unknown): Envelope | null {
    if (!input || typeof input !== "object") {
      this.emit("error", new ValidationError("Envelope must be an object"));
      return null;
    }

    const candidate = input as Partial<Envelope>;
    const validTypes = new Set([
      "subscribe",
      "unsubscribe",
      "publish",
      "message",
      "error",
      "info",
    ]);

    if (typeof candidate.type !== "string" || !validTypes.has(candidate.type)) {
      this.emit("error", new ValidationError("Envelope type is invalid"));
      return null;
    }

    if (candidate.room !== undefined && typeof candidate.room !== "string") {
      this.emit("error", new ValidationError("Envelope room must be a string"));
      return null;
    }

    if (candidate.event !== undefined && typeof candidate.event !== "string") {
      this.emit(
        "error",
        new ValidationError("Envelope event must be a string"),
      );
      return null;
    }

    if (
      candidate.payloadType !== undefined &&
      candidate.payloadType !== "json" &&
      candidate.payloadType !== "text" &&
      candidate.payloadType !== "binary"
    ) {
      this.emit(
        "error",
        new ValidationError("Envelope payloadType is invalid"),
      );
      return null;
    }

    return candidate as Envelope;
  }

  private inferPayloadType(payload: unknown): PayloadType {
    if (typeof payload === "string") return "text";
    if (this.isBinaryPayload(payload)) return "binary";
    return "json";
  }

  private normalizePayloadForType(
    payload: unknown,
    payloadType: PayloadType,
  ): unknown {
    if (payloadType === "json") {
      return payload;
    }

    if (payloadType === "text") {
      if (typeof payload !== "string") {
        throw new ValidationError(
          "payload must be a string when payloadType is 'text'",
        );
      }
      return payload;
    }

    if (typeof payload === "string") {
      return payload;
    }

    if (!this.isBinaryPayload(payload)) {
      throw new ValidationError(
        "payload must be ArrayBuffer, TypedArray, DataView, or base64 string when payloadType is 'binary'",
      );
    }

    return this.toBase64(payload);
  }

  private isBinaryPayload(
    payload: unknown,
  ): payload is ArrayBuffer | ArrayBufferView {
    return payload instanceof ArrayBuffer || ArrayBuffer.isView(payload);
  }

  private toBase64(payload: ArrayBuffer | ArrayBufferView): string {
    const bytes =
      payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength,
          );

    if (typeof btoa === "function") {
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      return btoa(binary);
    }

    const maybeBuffer = (
      globalThis as {
        Buffer?: {
          from: (input: Uint8Array) => { toString: (enc: string) => string };
        };
      }
    ).Buffer;
    if (maybeBuffer) {
      return maybeBuffer.from(bytes).toString("base64");
    }

    throw new ValidationError("No base64 encoder available in this runtime");
  }

  private sendRaw(envelope: Envelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError();
    }

    this.ws.send(JSON.stringify(envelope));
  }

  private enqueuePublish(envelope: Envelope): void {
    const { maxSize, dropPolicy } = this.options.queue;

    if (this.queuedPublishes.length >= maxSize) {
      if (dropPolicy === "newest") {
        this.emit("droppedMessage", envelope);
        return;
      }

      const dropped = this.queuedPublishes.shift();
      if (dropped) this.emit("droppedMessage", dropped);
    }

    this.queuedPublishes.push(envelope);
  }

  private scheduleReconnect(): void {
    const retry = this.options.retry;
    if (!retry.enabled) return;
    if (this.reconnectAttempts >= retry.maxRetries) {
      this.emit("error", new SocketClientError("Reconnect limit reached"));
      return;
    }

    this.reconnectAttempts += 1;
    const base =
      retry.initialDelayMs * Math.pow(retry.factor, this.reconnectAttempts - 1);
    const clamped = Math.min(base, retry.maxDelayMs);
    const jitterDelta = clamped * retry.jitter;
    const delayMs = Math.max(
      0,
      Math.round(clamped + (Math.random() * 2 - 1) * jitterDelta),
    );

    this.emit("reconnectAttempt", { attempt: this.reconnectAttempts, delayMs });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => this.emit("error", error as Error));
    }, delayMs);
  }

  private failConnect(error: Error): void {
    this.rejectConnect(error);
    this.setState("closed");
  }

  private resolveConnect(): void {
    const resolve = this.connectResolve;
    this.resetConnectPromiseState();
    resolve?.();
  }

  private rejectConnect(error: Error): void {
    const reject = this.connectReject;
    this.resetConnectPromiseState();
    reject?.(error);
  }

  private resetConnectPromiseState(): void {
    this.clearConnectTimer();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private safeCloseSocket(code: number, reason: string): void {
    if (!this.ws) return;
    try {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(code, reason);
      }
    } catch (error) {
      this.emit(
        "error",
        new SocketClientError("Failed to close websocket", { cause: error }),
      );
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);
  }

  private emit<K extends keyof SocketClientEvents>(
    event: K,
    payload: SocketClientEvents[K],
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        (handler as EventHandler<SocketClientEvents[K]>)(payload);
      } catch (error) {
        this.options.logger?.error?.("event handler error", error);
      }
    }
  }

  private validateOptions(): void {
    const { connectTimeoutMs, ackTimeoutMs, retry, queue } = this.options;

    if (connectTimeoutMs <= 0 || !Number.isFinite(connectTimeoutMs)) {
      throw new ValidationError("connectTimeoutMs must be a positive number");
    }

    if (ackTimeoutMs <= 0 || !Number.isFinite(ackTimeoutMs)) {
      throw new ValidationError("ackTimeoutMs must be a positive number");
    }

    if (
      retry.initialDelayMs < 0 ||
      retry.maxDelayMs <= 0 ||
      retry.factor < 1 ||
      retry.maxRetries < 0
    ) {
      throw new ValidationError("retry options are invalid");
    }

    if (retry.jitter < 0 || retry.jitter > 1) {
      throw new ValidationError("retry.jitter must be between 0 and 1");
    }

    if (queue.maxSize <= 0) {
      throw new ValidationError("queue.maxSize must be greater than 0");
    }
  }

  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new ValidationError("URL protocol must be ws or wss");
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError("Invalid websocket URL");
    }
  }

  private assertRoom(room: string): void {
    this.assertNonEmpty(room, "room");
  }

  private assertNonEmpty(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ValidationError(`${field} must be a non-empty string`);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed || this.state === "disposed") {
      throw new DisposedError();
    }
  }
}
