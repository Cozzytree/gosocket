import { ConnectionClosedError, DisposedError, SocketClientError, TimeoutError, ValidationError, } from "./errors";
import { PacketType } from "./types";
const DEFAULT_OPTIONS = {
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
    sysListeners = new Map();
    // Track custom events sent from the server
    evtListeners = new Map();
    desiredRooms = new Set();
    activeRooms = new Set();
    pendingAcks = new Map();
    queuedPublishes = [];
    constructor(input) {
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
    get connectionState() {
        return this.state;
    }
    onSys(event, handler) {
        const set = this.sysListeners.get(event) ?? new Set();
        set.add(handler);
        this.sysListeners.set(event, set);
        return () => this.offSys(event, handler);
    }
    offSys(event, handler) {
        this.sysListeners.get(event)?.delete(handler);
    }
    on(event, handler) {
        const set = this.evtListeners.get(event) ?? new Set();
        set.add(handler);
        this.evtListeners.set(event, set);
        return () => this.off(event, handler);
    }
    off(event, handler) {
        this.evtListeners.get(event)?.delete(handler);
    }
    async connect() {
        this.assertNotDisposed();
        if (this.state === "open")
            return;
        if (this.connectPromise)
            return this.connectPromise;
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
                    if (nonce !== this.connectionNonce)
                        return;
                    this.handleMessage(event.data);
                };
                ws.onerror = () => {
                    if (nonce !== this.connectionNonce)
                        return;
                    const error = new SocketClientError("WebSocket encountered an error");
                    this.emit("error", error);
                };
                ws.onclose = (event) => {
                    if (nonce !== this.connectionNonce)
                        return;
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
                    }
                    else {
                        this.rejectConnect(new ConnectionClosedError());
                    }
                };
            }
            catch (error) {
                const wrapped = new SocketClientError("Failed to create WebSocket", {
                    cause: error,
                });
                this.rejectConnect(wrapped);
                this.setState("closed");
            }
        });
        return this.connectPromise;
    }
    disconnect(code = 1000, reason = "client_disconnect") {
        if (this.disposed)
            return;
        this.userClosed = true;
        this.clearReconnectTimer();
        if (!this.ws || this.ws.readyState === 3) {
            this.setState("closed");
            return;
        }
        this.setState("closing");
        this.safeCloseSocket(code, reason);
    }
    dispose() {
        if (this.disposed)
            return;
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
    }
    async emit(event, ...args) {
        this.assertNotDisposed();
        this.assertNonEmpty(event, "event");
        // Check if the last argument is an ack callback (Socket.IO style)
        let ackFn;
        if (args.length > 0 && typeof args[args.length - 1] === "function") {
            ackFn = args.pop();
        }
        const packet = {
            type: PacketType.Event,
            nsp: "/", // default namespace / room
            data: [event, ...args],
        };
        if (ackFn) {
            packet.id = ++this.nextAckId;
            this.waitForAck(packet.id, ackFn);
        }
        if (this.state === "open") {
            this.sendRaw(packet);
            return;
        }
        // Since we don't have EmitOptions inline as easily, default to not queueing unless re-implemented later.
        // For now, let's just queue everything if disconnected.
        this.enqueuePublish(packet);
        if (this.state === "idle" || this.state === "closed") {
            void this.connect().catch((error) => this.emitSys("error", error));
        }
    }
    waitForAck(id, callback) {
        const timer = setTimeout(() => {
            this.pendingAcks.delete(id);
            this.options.logger?.warn?.(`Ack timeout for id ${id}`);
        }, this.options.ackTimeoutMs);
        this.pendingAcks.set(id, {
            resolve: callback,
            reject: () => { }, // Not used directly in Socket.IO acks typically, timeouts are silent or warned
            timer,
        });
    }
    async sendWithAck(packet, id, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                return reject(new SocketClientError(`sendWithAck aborted`));
            }
            const timer = setTimeout(() => {
                this.pendingAcks.delete(id);
                reject(new SocketClientError(`Timeout waiting for ack on packet ${id}`));
            }, this.options.ackTimeoutMs);
            const ack = {
                resolve: (...args) => resolve(args),
                reject,
                timer,
            };
            this.pendingAcks.set(id, ack);
            if (signal) {
                signal.addEventListener("abort", () => {
                    this.removePendingAck(id);
                    reject(new SocketClientError(`sendWithAck aborted`));
                });
            }
            try {
                this.sendRaw(packet);
            }
            catch (error) {
                this.removePendingAck(id);
                reject(error);
            }
        });
    }
    removePendingAck(id) {
        const ack = this.pendingAcks.get(id);
        if (!ack)
            return;
        clearTimeout(ack.timer);
        this.pendingAcks.delete(id);
    }
    resolvePendingAck(id, args) {
        const ack = this.pendingAcks.get(id);
        if (!ack)
            return;
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
    async resubscribeAndFlush() {
        if (this.state !== "open")
            return;
        for (const room of this.desiredRooms) {
            try {
                if (this.activeRooms.has(room))
                    continue;
                await this.sendWithAck({ type: PacketType.Event, nsp: "/", data: ["subscribe", room] }, ++this.nextAckId);
                this.activeRooms.add(room);
            }
            catch (error) {
                this.options.logger?.warn?.(`failed to resubscribe room '${room}'`, error);
            }
        }
        while (this.queuedPublishes.length > 0 && this.state === "open") {
            const next = this.queuedPublishes.shift();
            if (!next)
                break;
            this.sendRaw(next);
        }
    }
    handleMessage(raw) {
        if (typeof raw !== "string") {
            this.emitSys("error", new ValidationError("Server sent non-text frame; ignoring message"));
            return;
        }
        let parsed;
        try {
            // Decode Socket.IO array payload: [event_name, args...]
            parsed = JSON.parse(raw);
        }
        catch {
            this.emitSys("error", new ValidationError("Server sent invalid JSON"));
            return;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
            return; // Invalid format
        }
        const eventName = parsed[0];
        const args = parsed.slice(1);
        // If it's a system message, handle it
        if (eventName === "error") {
            this.emitSys("error", new SocketClientError(`Server error: ${args[0]}`));
            return;
        }
        // Fire client custom event callback
        const handlers = this.evtListeners.get(eventName);
        if (handlers && handlers.size > 0) {
            for (const handler of handlers) {
                try {
                    handler(...args);
                }
                catch (error) {
                    this.options.logger?.error?.("event handler error", error);
                }
            }
        }
    }
    sendRaw(packet) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new ConnectionClosedError();
        }
        const serialized = JSON.stringify(packet.data);
        this.ws.send(serialized);
    }
    enqueuePublish(packet) {
        const { maxSize, dropPolicy } = this.options.queue;
        if (this.queuedPublishes.length >= maxSize) {
            if (dropPolicy === "newest") {
                return; // drop
            }
            this.queuedPublishes.shift();
        }
        this.queuedPublishes.push(packet);
    }
    scheduleReconnect() {
        const retry = this.options.retry;
        if (!retry.enabled)
            return;
        if (this.reconnectAttempts >= retry.maxRetries) {
            this.emitSys("error", new SocketClientError("Reconnect limit reached"));
            return;
        }
        this.reconnectAttempts += 1;
        const base = retry.initialDelayMs * Math.pow(retry.factor, this.reconnectAttempts - 1);
        const clamped = Math.min(base, retry.maxDelayMs);
        const jitterDelta = clamped * retry.jitter;
        const delayMs = Math.max(0, Math.round(clamped + (Math.random() * 2 - 1) * jitterDelta));
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
        if (!this.connectTimer)
            return;
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
    }
    clearReconnectTimer() {
        if (!this.reconnectTimer)
            return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }
    safeCloseSocket(code, reason) {
        if (!this.ws)
            return;
        try {
            if (this.ws.readyState === WebSocket.OPEN ||
                this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(code, reason);
            }
        }
        catch (error) {
            this.emitSys("error", new SocketClientError("Failed to close websocket", { cause: error }));
        }
    }
    setState(next) {
        if (this.state === next)
            return;
        this.state = next;
        this.emitSys("state", next);
    }
    emitSys(event, payload) {
        const handlers = this.sysListeners.get(event);
        if (!handlers || handlers.size === 0)
            return;
        for (const handler of handlers) {
            try {
                handler(payload);
            }
            catch (error) {
                this.options.logger?.error?.("event handler error", error);
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
        if (retry.initialDelayMs < 0 ||
            retry.maxDelayMs <= 0 ||
            retry.factor < 1 ||
            retry.maxRetries < 0) {
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
        }
        catch (error) {
            if (error instanceof ValidationError)
                throw error;
            throw new ValidationError("Invalid websocket URL");
        }
    }
    assertRoom(room) {
        this.assertNonEmpty(room, "room");
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
}
