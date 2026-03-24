import {
  ConnectionClosedError,
  DisposedError,
  SocketClientError,
  TimeoutError,
  ValidationError,
} from "./errors";
import type {
  ConnectionState,
  EventHandler,
  PendingAck,
  Packet,
  SocketClientEvents,
  SocketClientOptions,
} from "./types";
import { PacketType } from "./types";

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
  private nextAckId = 0;

  // Track system events (connect, disconnect, etc)
  private readonly sysListeners = new Map<
    keyof SocketClientEvents,
    Set<EventHandler<unknown>>
  >();

  // Track custom events sent from the server
  private readonly evtListeners = new Map<string, Set<EventHandler<any>>>();

  private readonly desiredRooms = new Set<string>();
  private readonly activeRooms = new Set<string>();
  private readonly pendingAcks = new Map<number, PendingAck>();
  private readonly queuedPackets: Packet[] = [];

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

  /** Number of packets queued while disconnected. */
  get queueSize(): number {
    return this.queuedPackets.length;
  }

  // ---------------------------------------------------------------------------
  // Public listener API
  // ---------------------------------------------------------------------------

  public onSys<K extends keyof SocketClientEvents>(
    event: K,
    handler: EventHandler<SocketClientEvents[K]>,
  ): () => void {
    const set = this.sysListeners.get(event) ?? new Set<EventHandler<unknown>>();
    set.add(handler as EventHandler<unknown>);
    this.sysListeners.set(event, set);
    return () => this.offSys(event, handler);
  }

  public offSys<K extends keyof SocketClientEvents>(
    event: K,
    handler: EventHandler<SocketClientEvents[K]>,
  ): void {
    this.sysListeners.get(event)?.delete(handler as EventHandler<unknown>);
  }

  public on(event: string, handler: EventHandler<any[]>): () => void {
    const set = this.evtListeners.get(event) ?? new Set<EventHandler<any[]>>();
    set.add(handler);
    this.evtListeners.set(event, set);
    return () => this.off(event, handler);
  }

  public off(event: string, handler: EventHandler<any[]>): void {
    this.evtListeners.get(event)?.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

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
          this.emitSys("open", undefined);
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
          this.emitSys("error", error);
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

          this.emitSys("close", {
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

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
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

    this.sysListeners.clear();
    this.evtListeners.clear();
    this.queuedPackets.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Emit
  // ---------------------------------------------------------------------------

  /**
   * Emit an event. If the last argument is a function it is treated as an ack
   * callback — the server must call ack(...) for it to fire.
   *
   * While disconnected the packet is queued and flushed on reconnect.
   */
  public async emit(event: string, ...args: any[]): Promise<void> {
    this.assertNotDisposed();
    this.assertNonEmpty(event, "event");

    // Ack callback: last argument is a function.
    let ackFn: ((...res: any[]) => void) | undefined;
    if (args.length > 0 && typeof args[args.length - 1] === "function") {
      ackFn = args.pop() as (...res: any[]) => void;
    }

    const packet: Packet = {
      type: PacketType.Event,
      nsp: "/",
      data: [event, ...args],
    };

    if (ackFn) {
      packet.id = ++this.nextAckId;
      this.registerAckCallback(packet.id, ackFn);
    }

    if (this.state === "open") {
      this.sendRaw(packet);
      return;
    }

    this.enqueuePacket(packet);
    if (this.state === "idle" || this.state === "closed") {
      void this.connect().catch((error) => this.emitSys("error", error as Error));
    }
  }

  // ---------------------------------------------------------------------------
  // Room helpers
  // ---------------------------------------------------------------------------

  /** Join a room. Queued when disconnected; replayed on reconnect. */
  public joinRoom(room: string): void {
    this.assertNonEmpty(room, "room");
    this.desiredRooms.add(room);
    if (this.state === "open" && !this.activeRooms.has(room)) {
      void this.subscribeRoom(room);
    }
  }

  /** Leave a room. */
  public leaveRoom(room: string): void {
    this.assertNonEmpty(room, "room");
    this.desiredRooms.delete(room);
    this.activeRooms.delete(room);
    if (this.state === "open") {
      void this.emit("unsubscribe", room);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Register an ack callback (Socket.IO style — fire-and-forget, not a
   * Promise). Cleans itself up on timeout.
   */
  private registerAckCallback(id: number, callback: (...args: any[]) => void): void {
    const timer = setTimeout(() => {
      if (this.pendingAcks.delete(id)) {
        this.options.logger?.warn?.(`Ack timeout for id ${id}`);
      }
    }, this.options.ackTimeoutMs);

    this.pendingAcks.set(id, {
      resolve: callback,
      reject: (err) => this.options.logger?.warn?.(`Ack ${id} rejected: ${err.message}`),
      timer,
    });
  }

  /**
   * Send an event and return a Promise that resolves with the ack args.
   * Used internally for room subscription with ack.
   */
  private sendWithAck(packet: Packet, signal?: AbortSignal): Promise<any[]> {
    const id = ++this.nextAckId;
    packet.id = id;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new SocketClientError("sendWithAck aborted"));
      }

      const timer = setTimeout(() => {
        if (this.pendingAcks.delete(id)) {
          reject(new TimeoutError(`Ack timeout for packet ${id}`));
        }
      }, this.options.ackTimeoutMs);

      this.pendingAcks.set(id, { resolve: (...args) => resolve(args), reject, timer });

      if (signal) {
        signal.addEventListener("abort", () => {
          this.removePendingAck(id);
          reject(new SocketClientError("sendWithAck aborted"));
        });
      }

      try {
        this.sendRaw(packet);
      } catch (error) {
        this.removePendingAck(id);
        reject(error);
      }
    });
  }

  private removePendingAck(id: number): void {
    const ack = this.pendingAcks.get(id);
    if (!ack) return;
    clearTimeout(ack.timer);
    this.pendingAcks.delete(id);
  }

  private resolvePendingAck(id: number, args: any[]): void {
    const ack = this.pendingAcks.get(id);
    if (!ack) return;
    clearTimeout(ack.timer);
    ack.resolve(...args);
    this.pendingAcks.delete(id);
  }

  private rejectAllPendingAcks(error: Error): void {
    for (const [, ack] of this.pendingAcks) {
      clearTimeout(ack.timer);
      ack.reject(error);
    }
    this.pendingAcks.clear();
  }

  private async subscribeRoom(room: string): Promise<void> {
    try {
      await this.sendWithAck({
        type: PacketType.Event,
        nsp: "/",
        data: ["subscribe", room],
      });
      this.activeRooms.add(room);
    } catch (error) {
      this.options.logger?.warn?.(`Failed to subscribe to room '${room}':`, error);
    }
  }

  private async resubscribeAndFlush(): Promise<void> {
    if (this.state !== "open") return;

    // Re-join all desired rooms that aren't active yet.
    for (const room of this.desiredRooms) {
      if (this.activeRooms.has(room)) continue;
      await this.subscribeRoom(room);
      if (this.state !== "open") return; // disconnected mid-flush
    }

    // Flush queued packets.
    while (this.queuedPackets.length > 0 && this.state === "open") {
      const next = this.queuedPackets.shift();
      if (!next) break;
      try {
        this.sendRaw(next);
      } catch {
        // Connection dropped mid-flush; remaining packets stay queued.
        this.queuedPackets.unshift(next);
        break;
      }
    }
  }

  private handleMessage(raw: string | ArrayBuffer | Blob): void {
    if (typeof raw !== "string") {
      this.emitSys(
        "error",
        new ValidationError("Server sent non-text frame; ignoring message"),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emitSys("error", new ValidationError("Server sent invalid JSON"));
      return;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) return;

    const eventName = parsed[0] as string;
    const args = (parsed as unknown[]).slice(1);

    // Server-side ack response: ["_ack_", ackID, ...resArgs]
    if (eventName === "_ack_") {
      const ackId = args[0] as number;
      if (typeof ackId === "number") {
        this.resolvePendingAck(ackId, args.slice(1));
      }
      return;
    }

    if (eventName === "error") {
      this.emitSys("error", new SocketClientError(`Server error: ${args[0]}`));
      return;
    }

    // Dispatch to user-registered handlers.
    const handlers = this.evtListeners.get(eventName);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          (handler as (...a: any[]) => void)(...args);
        } catch (error) {
          this.options.logger?.error?.("event handler threw", error);
        }
      }
    }
  }

  /**
   * Serialize and send a packet.
   *
   * Wire format:
   *   no ack:   ["eventName", ...args]
   *   with ack: [ackID, "eventName", ...args]   (ackID is a positive integer)
   */
  private sendRaw(packet: Packet): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError();
    }

    const payload = packet.id !== undefined
      ? [packet.id, ...packet.data]
      : packet.data;

    this.ws.send(JSON.stringify(payload));
  }

  private enqueuePacket(packet: Packet): void {
    const { maxSize, dropPolicy } = this.options.queue;

    if (this.queuedPackets.length >= maxSize) {
      if (dropPolicy === "newest") return;
      this.queuedPackets.shift(); // drop oldest
    }

    this.queuedPackets.push(packet);
  }

  private scheduleReconnect(): void {
    const retry = this.options.retry;
    if (!retry.enabled) return;
    if (this.reconnectAttempts >= retry.maxRetries) {
      this.emitSys("error", new SocketClientError("Reconnect limit reached"));
      return;
    }

    this.reconnectAttempts += 1;
    const base = retry.initialDelayMs * Math.pow(retry.factor, this.reconnectAttempts - 1);
    const clamped = Math.min(base, retry.maxDelayMs);
    const jitter = clamped * retry.jitter;
    const delayMs = Math.max(0, Math.round(clamped + (Math.random() * 2 - 1) * jitter));

    this.emitSys("reconnectAttempt", { attempt: this.reconnectAttempts, delayMs });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => this.emitSys("error", error as Error));
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
      this.emitSys("error", new SocketClientError("Failed to close websocket", { cause: error }));
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitSys("state", next);
  }

  private emitSys<K extends keyof SocketClientEvents>(
    event: K,
    payload: SocketClientEvents[K],
  ): void {
    const handlers = this.sysListeners.get(event);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        (handler as EventHandler<SocketClientEvents[K]>)(payload);
      } catch (error) {
        this.options.logger?.error?.("sys event handler threw", error);
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
