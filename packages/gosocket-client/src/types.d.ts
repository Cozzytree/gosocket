export type EnvelopeType = "subscribe" | "unsubscribe" | "publish" | "message" | "error" | "info";
export interface Envelope {
    type: EnvelopeType;
    room?: string;
    event?: string;
    payload?: unknown;
}
export interface RetryOptions {
    enabled: boolean;
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
    maxRetries: number;
    jitter: number;
}
export interface QueueOptions {
    maxSize: number;
    dropPolicy: "oldest" | "newest";
}
export interface SocketClientOptions {
    url: string;
    protocols?: string | string[];
    connectTimeoutMs: number;
    ackTimeoutMs: number;
    retry: RetryOptions;
    queue: QueueOptions;
    logger: Pick<Console, "debug" | "warn" | "error">;
}
export interface PublishOptions {
    queueIfDisconnected?: boolean;
    signal?: AbortSignal;
}
export type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed" | "disposed";
export interface CloseInfo {
    code: number;
    reason: string;
    wasClean: boolean;
}
export interface SocketClientEvents {
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
export type EventHandler<T> = (payload: T) => void;
export interface PendingAck {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}
export type AckKey = `${"subscribe" | "unsubscribe"}:${string}`;
