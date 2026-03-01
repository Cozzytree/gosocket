export declare class SocketClientError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare class ValidationError extends SocketClientError {
    constructor(message: string);
}
export declare class DisposedError extends SocketClientError {
    constructor();
}
export declare class ConnectionClosedError extends SocketClientError {
    constructor();
}
export declare class TimeoutError extends SocketClientError {
    constructor(message: string);
}
