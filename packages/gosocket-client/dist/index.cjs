"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ConnectionClosedError: () => ConnectionClosedError,
  DisposedError: () => DisposedError,
  SocketClient: () => SocketClient,
  SocketClientError: () => SocketClientError,
  TimeoutError: () => TimeoutError,
  ValidationError: () => ValidationError
});
module.exports = __toCommonJS(index_exports);

// src/errors.ts
var SocketClientError = class extends Error {
  constructor(message, options) {
    super(message);
    this.name = "SocketClientError";
    if (options?.cause !== void 0) {
      this.cause = options.cause;
    }
  }
};
var ValidationError = class extends SocketClientError {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
var DisposedError = class extends SocketClientError {
  constructor() {
    super("Socket client has been disposed");
    this.name = "DisposedError";
  }
};
var ConnectionClosedError = class extends SocketClientError {
  constructor() {
    super("Socket connection is not open");
    this.name = "ConnectionClosedError";
  }
};
var TimeoutError = class extends SocketClientError {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
};

// src/client.ts
var DEFAULT_OPTIONS = {
  connectTimeoutMs: 8e3,
  ackTimeoutMs: 5e3,
  retry: {
    enabled: true,
    initialDelayMs: 500,
    maxDelayMs: 1e4,
    factor: 1.8,
    maxRetries: 30,
    jitter: 0.25
  },
  queue: {
    maxSize: 200,
    dropPolicy: "oldest"
  },
  logger: console
};
var SocketClient = class {
  options;
  ws = null;
  state = "idle";
  disposed = false;
  userClosed = false;
  reconnectAttempts = 0;
  connectPromise = null;
  connectResolve = null;
  connectReject = null;
  connectTimer = null;
  reconnectTimer = null;
  connectionNonce = 0;
  nextAckId = 0;
  // Track system events (connect, disconnect, etc)
  sysListeners = /* @__PURE__ */ new Map();
  // Track custom events sent from the server
  evtListeners = /* @__PURE__ */ new Map();
  desiredRooms = /* @__PURE__ */ new Set();
  activeRooms = /* @__PURE__ */ new Set();
  pendingAcks = /* @__PURE__ */ new Map();
  queuedPackets = [];
  constructor(input) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...input,
      retry: { ...DEFAULT_OPTIONS.retry, ...input.retry },
      queue: { ...DEFAULT_OPTIONS.queue, ...input.queue },
      logger: input.logger ?? DEFAULT_OPTIONS.logger
    };
    this.validateUrl(this.options.url);
    this.validateOptions();
  }
  get connectionState() {
    return this.state;
  }
  /** Number of packets queued while disconnected. */
  get queueSize() {
    return this.queuedPackets.length;
  }
  // ---------------------------------------------------------------------------
  // Public listener API
  // ---------------------------------------------------------------------------
  onSys(event, handler) {
    const set = this.sysListeners.get(event) ?? /* @__PURE__ */ new Set();
    set.add(handler);
    this.sysListeners.set(event, set);
    return () => this.offSys(event, handler);
  }
  offSys(event, handler) {
    this.sysListeners.get(event)?.delete(handler);
  }
  on(event, handler) {
    const set = this.evtListeners.get(event) ?? /* @__PURE__ */ new Set();
    set.add(handler);
    this.evtListeners.set(event, set);
    return () => this.off(event, handler);
  }
  off(event, handler) {
    this.evtListeners.get(event)?.delete(handler);
  }
  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------
  async connect() {
    this.assertNotDisposed();
    if (this.state === "open") return;
    if (this.connectPromise) return this.connectPromise;
    this.userClosed = false;
    this.setState("connecting");
    const nonce = ++this.connectionNonce;
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      try {
        const ws = new WebSocket(this.options.url, this.options.protocols);
        this.ws = ws;
        this.connectTimer = setTimeout(() => {
          this.failConnect(new TimeoutError("Connection timed out"));
          this.safeCloseSocket(4e3, "connect_timeout");
        }, this.options.connectTimeoutMs);
        ws.onopen = () => {
          if (nonce !== this.connectionNonce) {
            this.safeCloseSocket(1e3, "stale_connection");
            return;
          }
          this.clearConnectTimer();
          this.reconnectAttempts = 0;
          this.setState("open");
          this.emitSys("open", void 0);
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
            wasClean: event.wasClean
          });
          if (!this.userClosed && !this.disposed) {
            this.scheduleReconnect();
          } else {
            this.rejectConnect(new ConnectionClosedError());
          }
        };
      } catch (error) {
        const wrapped = new SocketClientError("Failed to create WebSocket", {
          cause: error
        });
        this.rejectConnect(wrapped);
        this.setState("closed");
      }
    });
    return this.connectPromise;
  }
  disconnect(code = 1e3, reason = "client_disconnect") {
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
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.userClosed = true;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.rejectAllPendingAcks(new DisposedError());
    this.rejectConnect(new DisposedError());
    this.setState("disposed");
    this.safeCloseSocket(1e3, "disposed");
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
  async emit(event, ...args) {
    this.assertNotDisposed();
    this.assertNonEmpty(event, "event");
    let ackFn;
    if (args.length > 0 && typeof args[args.length - 1] === "function") {
      ackFn = args.pop();
    }
    const packet = {
      type: 2 /* Event */,
      nsp: "/",
      data: [event, ...args]
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
      void this.connect().catch((error) => this.emitSys("error", error));
    }
  }
  // ---------------------------------------------------------------------------
  // Room helpers
  // ---------------------------------------------------------------------------
  /** Join a room. Queued when disconnected; replayed on reconnect. */
  joinRoom(room) {
    this.assertNonEmpty(room, "room");
    this.desiredRooms.add(room);
    if (this.state === "open" && !this.activeRooms.has(room)) {
      void this.subscribeRoom(room);
    }
  }
  /** Leave a room. */
  leaveRoom(room) {
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
  registerAckCallback(id, callback) {
    const timer = setTimeout(() => {
      if (this.pendingAcks.delete(id)) {
        this.options.logger?.warn?.(`Ack timeout for id ${id}`);
      }
    }, this.options.ackTimeoutMs);
    this.pendingAcks.set(id, {
      resolve: callback,
      reject: (err) => this.options.logger?.warn?.(`Ack ${id} rejected: ${err.message}`),
      timer
    });
  }
  /**
   * Send an event and return a Promise that resolves with the ack args.
   * Used internally for room subscription with ack.
   */
  sendWithAck(packet, signal) {
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
  removePendingAck(id) {
    const ack = this.pendingAcks.get(id);
    if (!ack) return;
    clearTimeout(ack.timer);
    this.pendingAcks.delete(id);
  }
  resolvePendingAck(id, args) {
    const ack = this.pendingAcks.get(id);
    if (!ack) return;
    clearTimeout(ack.timer);
    ack.resolve(...args);
    this.pendingAcks.delete(id);
  }
  rejectAllPendingAcks(error) {
    for (const [, ack] of this.pendingAcks) {
      clearTimeout(ack.timer);
      ack.reject(error);
    }
    this.pendingAcks.clear();
  }
  async subscribeRoom(room) {
    try {
      await this.sendWithAck({
        type: 2 /* Event */,
        nsp: "/",
        data: ["subscribe", room]
      });
      this.activeRooms.add(room);
    } catch (error) {
      this.options.logger?.warn?.(`Failed to subscribe to room '${room}':`, error);
    }
  }
  async resubscribeAndFlush() {
    if (this.state !== "open") return;
    for (const room of this.desiredRooms) {
      if (this.activeRooms.has(room)) continue;
      await this.subscribeRoom(room);
      if (this.state !== "open") return;
    }
    while (this.queuedPackets.length > 0 && this.state === "open") {
      const next = this.queuedPackets.shift();
      if (!next) break;
      try {
        this.sendRaw(next);
      } catch {
        this.queuedPackets.unshift(next);
        break;
      }
    }
  }
  handleMessage(raw) {
    if (typeof raw !== "string") {
      this.emitSys(
        "error",
        new ValidationError("Server sent non-text frame; ignoring message")
      );
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emitSys("error", new ValidationError("Server sent invalid JSON"));
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    const eventName = parsed[0];
    const args = parsed.slice(1);
    if (eventName === "_ack_") {
      const ackId = args[0];
      if (typeof ackId === "number") {
        this.resolvePendingAck(ackId, args.slice(1));
      }
      return;
    }
    if (eventName === "error") {
      this.emitSys("error", new SocketClientError(`Server error: ${args[0]}`));
      return;
    }
    const handlers = this.evtListeners.get(eventName);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          handler(...args);
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
  sendRaw(packet) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError();
    }
    const payload = packet.id !== void 0 ? [packet.id, ...packet.data] : packet.data;
    this.ws.send(JSON.stringify(payload));
  }
  enqueuePacket(packet) {
    const { maxSize, dropPolicy } = this.options.queue;
    if (this.queuedPackets.length >= maxSize) {
      if (dropPolicy === "newest") return;
      this.queuedPackets.shift();
    }
    this.queuedPackets.push(packet);
  }
  scheduleReconnect() {
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
      void this.connect().catch((error) => this.emitSys("error", error));
    }, delayMs);
  }
  failConnect(error) {
    this.rejectConnect(error);
    this.setState("closed");
  }
  resolveConnect() {
    const resolve = this.connectResolve;
    this.resetConnectPromiseState();
    resolve?.();
  }
  rejectConnect(error) {
    const reject = this.connectReject;
    this.resetConnectPromiseState();
    reject?.(error);
  }
  resetConnectPromiseState() {
    this.clearConnectTimer();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }
  clearConnectTimer() {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }
  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  safeCloseSocket(code, reason) {
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(code, reason);
      }
    } catch (error) {
      this.emitSys("error", new SocketClientError("Failed to close websocket", { cause: error }));
    }
  }
  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emitSys("state", next);
  }
  emitSys(event, payload) {
    const handlers = this.sysListeners.get(event);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (error) {
        this.options.logger?.error?.("sys event handler threw", error);
      }
    }
  }
  validateOptions() {
    const { connectTimeoutMs, ackTimeoutMs, retry, queue } = this.options;
    if (connectTimeoutMs <= 0 || !Number.isFinite(connectTimeoutMs)) {
      throw new ValidationError("connectTimeoutMs must be a positive number");
    }
    if (ackTimeoutMs <= 0 || !Number.isFinite(ackTimeoutMs)) {
      throw new ValidationError("ackTimeoutMs must be a positive number");
    }
    if (retry.initialDelayMs < 0 || retry.maxDelayMs <= 0 || retry.factor < 1 || retry.maxRetries < 0) {
      throw new ValidationError("retry options are invalid");
    }
    if (retry.jitter < 0 || retry.jitter > 1) {
      throw new ValidationError("retry.jitter must be between 0 and 1");
    }
    if (queue.maxSize <= 0) {
      throw new ValidationError("queue.maxSize must be greater than 0");
    }
  }
  validateUrl(url) {
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
  assertNonEmpty(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ValidationError(`${field} must be a non-empty string`);
    }
  }
  assertNotDisposed() {
    if (this.disposed || this.state === "disposed") {
      throw new DisposedError();
    }
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ConnectionClosedError,
  DisposedError,
  SocketClient,
  SocketClientError,
  TimeoutError,
  ValidationError
});
