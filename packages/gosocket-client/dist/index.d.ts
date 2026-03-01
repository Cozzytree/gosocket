type EnvelopeType = "subscribe" | "unsubscribe" | "publish" | "message" | "error" | "info";
interface Envelope {
    type: EnvelopeType;
    room?: string;
    event?: string;
    payload?: unknown;
}
interface RetryOptions {
    enabled: boolean;
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
    maxRetries: number;
    jitter: number;
}
interface QueueOptions {
    maxSize: number;
    dropPolicy: "oldest" | "newest";
}
interface SocketClientOptions {
    url: string;
    protocols?: string | string[];
    connectTimeoutMs: number;
    ackTimeoutMs: number;
    retry: RetryOptions;
    queue: QueueOptions;
    logger: Pick<Console, "debug" | "warn" | "error">;
}
interface PublishOptions {
    queueIfDisconnected?: boolean;
    signal?: AbortSignal;
}
type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed" | "disposed";
interface CloseInfo {
    code: number;
    reason: string;
    wasClean: boolean;
}
interface SocketClientEvents {
    state: ConnectionState;
    open: void;
    close: CloseInfo;
    error: Error;
    message: Envelope;
    reconnectAttempt: {
        attempt: number;
        delayMs: number;
    };
    droppedMessage: Envelope;
}
type EventHandler<T> = (payload: T) => void;

declare class SocketClient {
    private readonly options;
    private ws;
    private state;
    private disposed;
    private userClosed;
    private reconnectAttempts;
    private connectPromise;
    private connectResolve;
    private connectReject;
    private connectTimer;
    private reconnectTimer;
    private connectionNonce;
    private readonly listeners;
    private readonly desiredRooms;
    private readonly activeRooms;
    private readonly pendingAcks;
    private readonly queuedPublishes;
    constructor(input: Partial<SocketClientOptions> & Pick<SocketClientOptions, "url">);
    get connectionState(): ConnectionState;
    on<K extends keyof SocketClientEvents>(event: K, handler: EventHandler<SocketClientEvents[K]>): () => void;
    off<K extends keyof SocketClientEvents>(event: K, handler: EventHandler<SocketClientEvents[K]>): void;
    connect(): Promise<void>;
    disconnect(code?: number, reason?: string): void;
    dispose(): void;
    subscribe(room: string, signal?: AbortSignal): Promise<void>;
    unsubscribe(room: string, signal?: AbortSignal): Promise<void>;
    publish(room: string, event: string, payload: unknown, options?: PublishOptions): Promise<void>;
    private sendWithAck;
    private waitForAck;
    private removePendingAck;
    private resolvePendingAck;
    private rejectAllPendingAcks;
    private resubscribeAndFlush;
    private handleMessage;
    private validateEnvelope;
    private sendRaw;
    private enqueuePublish;
    private scheduleReconnect;
    private failConnect;
    private resolveConnect;
    private rejectConnect;
    private resetConnectPromiseState;
    private clearConnectTimer;
    private clearReconnectTimer;
    private safeCloseSocket;
    private setState;
    private emit;
    private validateOptions;
    private validateUrl;
    private assertRoom;
    private assertNonEmpty;
    private assertNotDisposed;
}

declare class SocketClientError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
declare class ValidationError extends SocketClientError {
    constructor(message: string);
}
declare class DisposedError extends SocketClientError {
    constructor();
}
declare class ConnectionClosedError extends SocketClientError {
    constructor();
}
declare class TimeoutError extends SocketClientError {
    constructor(message: string);
}

export { type CloseInfo, ConnectionClosedError, type ConnectionState, DisposedError, type Envelope, type PublishOptions, type QueueOptions, type RetryOptions, SocketClient, SocketClientError, type SocketClientEvents, type SocketClientOptions, TimeoutError, ValidationError };
