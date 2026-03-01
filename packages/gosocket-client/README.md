# @gosocket/client

TypeScript websocket client for the Go `gosocket` server.

## Goals

- deterministic connection state (`idle`, `connecting`, `open`, `closing`, `closed`, `disposed`)
- bounded queue when disconnected (optional)
- subscribe/unsubscribe acknowledgements with timeout handling
- exponential reconnect with jitter
- no silent handler crashes (listener errors are trapped)

## Usage

```ts
import { SocketClient } from "@gosocket/client";

const client = new SocketClient({ url: "ws://localhost:8080/ws" });

client.on("message", (msg) => {
  console.log(msg);
});

await client.connect();
await client.subscribe("news");
await client.publish("news", "headline", { title: "hello" });
await client.publish("news", "headline", "plain text body", { payloadType: "text" });
await client.publish("news", "blob", new Uint8Array([1, 2, 3, 4]), { payloadType: "binary" });
```

## Events

- `state`
- `open`
- `close`
- `error`
- `message`
- `reconnectAttempt`
- `droppedMessage`
