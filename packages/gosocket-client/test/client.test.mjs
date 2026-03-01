import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { SocketClient } from "../dist/index.js";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }
}

const realWebSocket = globalThis.WebSocket;

function installFakeSocket() {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
}

function uninstallFakeSocket() {
  globalThis.WebSocket = realWebSocket;
}

async function waitFor(check, timeoutMs = 200) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition was not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  installFakeSocket();
});

afterEach(() => {
  uninstallFakeSocket();
});

test("disconnect from idle transitions to closed", () => {
  const client = new SocketClient({ url: "ws://localhost:8080/ws" });
  client.disconnect();
  assert.equal(client.connectionState, "closed");
});

test("subscribe resolves on server subscribed ack", async () => {
  const client = new SocketClient({ url: "ws://localhost:8080/ws" });

  const connectPromise = client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await connectPromise;

  const subscribePromise = client.subscribe("news");
  await waitFor(() => ws.sent.length > 0);
  const sent = JSON.parse(ws.sent[0]);
  assert.equal(sent.type, "subscribe");
  assert.equal(sent.room, "news");

  ws.message({ type: "info", room: "news", event: "subscribed" });
  await subscribePromise;
  assert.equal(client.connectionState, "open");
});

test("binary publish is encoded as base64 string", async () => {
  const client = new SocketClient({ url: "ws://localhost:8080/ws" });

  const connectPromise = client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await connectPromise;

  await client.publish("news", "blob", new Uint8Array([1, 2, 3]), {
    payloadType: "binary",
  });

  const sent = JSON.parse(ws.sent[0]);
  assert.equal(sent.type, "publish");
  assert.equal(sent.payloadType, "binary");
  assert.equal(sent.payload, "AQID");
});
