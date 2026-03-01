export class SocketClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SocketClientError";
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ValidationError extends SocketClientError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class DisposedError extends SocketClientError {
  constructor() {
    super("Socket client has been disposed");
    this.name = "DisposedError";
  }
}

export class ConnectionClosedError extends SocketClientError {
  constructor() {
    super("Socket connection is not open");
    this.name = "ConnectionClosedError";
  }
}

export class TimeoutError extends SocketClientError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
