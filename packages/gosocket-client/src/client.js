import { ConnectionClosedError, DisposedError, SocketClientError, TimeoutError, ValidationError, } from "./errors";
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
    listeners = new Map();
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
    on(event, handler) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return () => this.off(event, handler);
    }
    off(event, handler) {
        this.listeners.get(event)?.delete(handler);
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
                const wrapped = new SocketClientError("Failed to create WebSocket", { cause: error });
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
        this.listeners.clear();
    }
    async subscribe(room, signal) {
        this.assertNotDisposed();
        this.assertRoom(room);
        this.desiredRooms.add(room);
        if (this.activeRooms.has(room) && this.state === "open") {
            return;
        }
        await this.connect();
        await this.sendWithAck({ type: "subscribe", room }, room, "subscribe", signal);
        this.activeRooms.add(room);
    }
    async unsubscribe(room, signal) {
        this.assertNotDisposed();
        this.assertRoom(room);
        this.desiredRooms.delete(room);
        if (this.state !== "open") {
            this.activeRooms.delete(room);
            return;
        }
        await this.sendWithAck({ type: "unsubscribe", room }, room, "unsubscribe", signal);
        this.activeRooms.delete(room);
    }
    async publish(room, event, payload, options = {}) {
        this.assertNotDisposed();
        this.assertRoom(room);
        this.assertNonEmpty(event, "event");
        const envelope = { type: "publish", room, event, payload };
        if (this.state === "open") {
            this.sendRaw(envelope);
            return;
        }
        if (options.queueIfDisconnected) {
            this.enqueuePublish(envelope);
            if (this.state === "idle" || this.state === "closed") {
                void this.connect().catch((error) => this.emit("error", error));
            }
            return;
        }
        throw new ConnectionClosedError();
    }
    async sendWithAck(envelope, room, action, signal) {
        if (this.state !== "open") {
            throw new ConnectionClosedError();
        }
        const ackPromise = this.waitForAck(room, action, signal);
        this.sendRaw(envelope);
        await ackPromise;
    }
    waitForAck(room, action, signal) {
        const key = `${action}:${room}`;
        return new Promise((resolve, reject) => {
            let ack;
            const onAbort = () => {
                cleanup();
                if (ack)
                    this.removePendingAck(key, ack);
                reject(new SocketClientError(`${action} aborted`));
            };
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            };
            const timer = setTimeout(() => {
                cleanup();
                if (ack)
                    this.removePendingAck(key, ack);
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
                reject: (error) => {
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
    removePendingAck(key, ack) {
        const list = this.pendingAcks.get(key);
        if (!list)
            return;
        const index = list.indexOf(ack);
        if (index >= 0) {
            list.splice(index, 1);
        }
        if (list.length === 0) {
            this.pendingAcks.delete(key);
        }
    }
    resolvePendingAck(action, room) {
        const key = `${action}:${room}`;
        const list = this.pendingAcks.get(key);
        if (!list || list.length === 0)
            return;
        const next = list.shift();
        if (!next)
            return;
        clearTimeout(next.timer);
        next.resolve();
        if (list.length === 0) {
            this.pendingAcks.delete(key);
        }
    }
    rejectAllPendingAcks(error) {
        for (const [, list] of this.pendingAcks) {
            for (const pending of list) {
                clearTimeout(pending.timer);
                pending.reject(error);
            }
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
                await this.sendWithAck({ type: "subscribe", room }, room, "subscribe");
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
            this.emit("error", new ValidationError("Server sent non-text frame; ignoring message"));
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            this.emit("error", new ValidationError("Server sent invalid JSON"));
            return;
        }
        const env = this.validateEnvelope(parsed);
        if (!env)
            return;
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
            this.emit("error", new SocketClientError(`Server error event '${env.event ?? "unknown"}'`));
        }
        this.emit("message", env);
    }
    validateEnvelope(input) {
        if (!input || typeof input !== "object") {
            this.emit("error", new ValidationError("Envelope must be an object"));
            return null;
        }
        const candidate = input;
        const validTypes = new Set(["subscribe", "unsubscribe", "publish", "message", "error", "info"]);
        if (typeof candidate.type !== "string" || !validTypes.has(candidate.type)) {
            this.emit("error", new ValidationError("Envelope type is invalid"));
            return null;
        }
        if (candidate.room !== undefined && typeof candidate.room !== "string") {
            this.emit("error", new ValidationError("Envelope room must be a string"));
            return null;
        }
        if (candidate.event !== undefined && typeof candidate.event !== "string") {
            this.emit("error", new ValidationError("Envelope event must be a string"));
            return null;
        }
        return candidate;
    }
    sendRaw(envelope) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new ConnectionClosedError();
        }
        this.ws.send(JSON.stringify(envelope));
    }
    enqueuePublish(envelope) {
        const { maxSize, dropPolicy } = this.options.queue;
        if (this.queuedPublishes.length >= maxSize) {
            if (dropPolicy === "newest") {
                this.emit("droppedMessage", envelope);
                return;
            }
            const dropped = this.queuedPublishes.shift();
            if (dropped)
                this.emit("droppedMessage", dropped);
        }
        this.queuedPublishes.push(envelope);
    }
    scheduleReconnect() {
        const retry = this.options.retry;
        if (!retry.enabled)
            return;
        if (this.reconnectAttempts >= retry.maxRetries) {
            this.emit("error", new SocketClientError("Reconnect limit reached"));
            return;
        }
        this.reconnectAttempts += 1;
        const base = retry.initialDelayMs * Math.pow(retry.factor, this.reconnectAttempts - 1);
        const clamped = Math.min(base, retry.maxDelayMs);
        const jitterDelta = clamped * retry.jitter;
        const delayMs = Math.max(0, Math.round(clamped + (Math.random() * 2 - 1) * jitterDelta));
        this.emit("reconnectAttempt", { attempt: this.reconnectAttempts, delayMs });
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            void this.connect().catch((error) => this.emit("error", error));
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
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(code, reason);
            }
        }
        catch (error) {
            this.emit("error", new SocketClientError("Failed to close websocket", { cause: error }));
        }
    }
    setState(next) {
        if (this.state === next)
            return;
        this.state = next;
        this.emit("state", next);
    }
    emit(event, payload) {
        const handlers = this.listeners.get(event);
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
