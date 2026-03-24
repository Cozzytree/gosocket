// Socket.IO wire types
export enum PacketType {
  Event = 2,
  Ack = 3,
  Error = 4,
}

export type AckFn = (...args: any[]) => void;

// Equivalent to [type, name, ...args, ackId?]
export interface Packet {
  type: PacketType;
  nsp: string; // Used as Room in our architecture
  data: any[]; // [eventName, ...args]
  id?: number;
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

export interface EmitOptions {
  queueIfDisconnected?: boolean;
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
  reconnectAttempt: { attempt: number; delayMs: number };
}

export type EventHandler<T> = (payload: T) => void;

export interface PendingAck {
  resolve: (...args: any[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
