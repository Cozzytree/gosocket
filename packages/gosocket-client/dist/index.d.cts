declare enum PacketType {
    Event = 2,
    Ack = 3,
    Error = 4
}
interface Packet {
    type: PacketType;
    nsp: string;
    data: any[];
    id?: number;
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
interface EmitOptions {
    queueIfDisconnected?: boolean;
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
    reconnectAttempt: {
        attempt: number;
        delayMs: number;
    };
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
    private nextAckId;
    private readonly sysListeners;
    private readonly evtListeners;
    private readonly desiredRooms;
    private readonly activeRooms;
    private readonly pendingAcks;
    private readonly queuedPublishes;
    constructor(input: Partial<SocketClientOptions> & Pick<SocketClientOptions, "url">);
    get connectionState(): ConnectionState;
    onSys<K extends keyof SocketClientEvents>(event: K, handler: EventHandler<SocketClientEvents[K]>): () => void;
    offSys<K extends keyof SocketClientEvents>(event: K, handler: EventHandler<SocketClientEvents[K]>): void;
    on(event: string, handler: EventHandler<any[]>): () => void;
    off(event: string, handler: EventHandler<any[]>): void;
    connect(): Promise<void>;
    disconnect(code?: number, reason?: string): void;
    dispose(): void;
    emit(event: string, ...args: any[]): Promise<void>;
    private waitForAck;
    private sendWithAck;
    private removePendingAck;
    private resolvePendingAck;
    private rejectAllPendingAcks;
    private resubscribeAndFlush;
    private handleMessage;
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
    private emitSys;
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

export { type CloseInfo, ConnectionClosedError, type ConnectionState, DisposedError, type EmitOptions, type Packet, PacketType, type QueueOptions, type RetryOptions, SocketClient, SocketClientError, type SocketClientEvents, type SocketClientOptions, TimeoutError, ValidationError };
