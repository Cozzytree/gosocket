# gosocket

Go websocket server/library with socket.io-like room semantics, plus a robust TypeScript client package.

## Repository structure

- `cmd/server`: runnable Go HTTP server (`/ws`, `/healthz`)
- `pkg/socket`: reusable Go socket library
- `internal/config`: app-level Go config
- `packages/gosocket-client`: TypeScript client library with retry/ack/error guards
- `apps/client-demo`: Vite demo app that uses `@gosocket/client`
- `examples`: minimal plain HTML websocket example

## Run the Go server

```bash
cd /home/cozzycode/workspace/gosocket
go run ./cmd/server
```

Default address: `:8080` (override with `ADDR`).

## Install JS workspace (pnpm)

```bash
cd /home/cozzycode/workspace/gosocket
pnpm install
```

## Build all JS packages

```bash
pnpm build
```

## Start the Vite demo

```bash
pnpm --filter client-demo dev
```

Open the printed local URL from Vite and connect to `ws://localhost:8080/ws`.

## Websocket envelope

Client->server:

```json
{
  "type": "subscribe|unsubscribe|publish",
  "room": "news",
  "event": "headline",
  "payloadType": "json|text|binary",
  "payload": {"any":"json"}
}
```

`payloadType` defaults to `json`. For `text`, `payload` must be a JSON string. For `binary`, `payload` must be a base64 string.

Server->client:

- `type: "info"` for ack events (`subscribed`, `unsubscribed`)
- `type: "message"` for room broadcasts
- `type: "error"` for protocol problems
