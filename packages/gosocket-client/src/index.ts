export { SocketClient } from "./client";
export {
  ConnectionClosedError,
  DisposedError,
  SocketClientError,
  TimeoutError,
  ValidationError,
} from "./errors";
export type {
  CloseInfo,
  ConnectionState,
  Packet,
  PacketType,
  EmitOptions,
  QueueOptions,
  RetryOptions,
  SocketClientEvents,
  SocketClientOptions,
} from "./types";
