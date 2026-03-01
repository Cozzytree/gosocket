import "./style.css";
import { SocketClient, type Envelope, type PayloadType } from "@gosocket/client";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");

app.innerHTML = `
  <div class="panel">
    <h1>gosocket client demo</h1>
    <div class="status" id="status">state: idle</div>

    <div class="row">
      <input id="url" value="ws://localhost:8080/ws" />
      <button id="connect">Connect</button>
      <button id="disconnect" class="secondary">Disconnect</button>
    </div>

    <div class="row">
      <input id="room" value="news" placeholder="room" />
      <button id="subscribe">Subscribe</button>
      <button id="unsubscribe" class="secondary">Unsubscribe</button>
    </div>

    <div class="row">
      <input id="event" value="headline" placeholder="event" />
      <select id="payloadType">
        <option value="json" selected>json</option>
        <option value="text">text</option>
        <option value="binary">binary(base64)</option>
      </select>
      <input id="payload" value='{"title":"hello"}' placeholder='{"json":"payload"}' />
      <button id="publish">Publish</button>
      <button id="publishQueued" class="warn">Publish (queue)</button>
    </div>

    <div class="log" id="log"></div>
  </div>
`;

const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const logEl = document.querySelector<HTMLDivElement>("#log")!;
const urlEl = document.querySelector<HTMLInputElement>("#url")!;
const roomEl = document.querySelector<HTMLInputElement>("#room")!;
const eventEl = document.querySelector<HTMLInputElement>("#event")!;
const payloadTypeEl = document.querySelector<HTMLSelectElement>("#payloadType")!;
const payloadEl = document.querySelector<HTMLInputElement>("#payload")!;

let client: SocketClient | null = null;

function log(line: string): void {
  const stamp = new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "time";
  logEl.textContent += `[${stamp}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function parsePayload(input: string, payloadType: PayloadType): unknown {
  if (payloadType === "json") {
    try {
      return JSON.parse(input);
    } catch {
      throw new Error("Payload must be valid JSON");
    }
  }
  return input;
}

function attachClient(next: SocketClient): void {
  next.on("state", (state) => {
    statusEl.textContent = `state: ${state}`;
    log(`state -> ${state}`);
  });

  next.on("open", () => log("open"));
  next.on("close", (info) => log(`close code=${info.code} reason=${info.reason || "<none>"} clean=${info.wasClean}`));
  next.on("error", (err) => log(`error: ${err.name}: ${err.message}`));
  next.on("reconnectAttempt", (a) => log(`reconnect attempt=${a.attempt} delay=${a.delayMs}ms`));
  next.on("droppedMessage", (m) => log(`dropped queued message room=${m.room} event=${m.event}`));
  next.on("message", (msg: Envelope) => log(`message: ${JSON.stringify(msg)}`));
}

function getClient(): SocketClient {
  if (!client) {
    client = new SocketClient({
      url: urlEl.value,
      connectTimeoutMs: 5000,
      ackTimeoutMs: 4000,
      retry: {
        enabled: true,
        initialDelayMs: 300,
        maxDelayMs: 5000,
        factor: 1.6,
        maxRetries: 25,
        jitter: 0.2,
      },
      queue: {
        maxSize: 100,
        dropPolicy: "oldest",
      },
    });
    attachClient(client);
  }
  return client;
}

async function safe(action: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    log(`${action}: ok`);
  } catch (err) {
    const e = err as Error;
    log(`${action}: failed -> ${e.name}: ${e.message}`);
  }
}

document.querySelector<HTMLButtonElement>("#connect")!.addEventListener("click", () => {
  void safe("connect", async () => {
    const c = getClient();
    await c.connect();
  });
});

document.querySelector<HTMLButtonElement>("#disconnect")!.addEventListener("click", () => {
  void safe("disconnect", () => {
    client?.disconnect();
  });
});

document.querySelector<HTMLButtonElement>("#subscribe")!.addEventListener("click", () => {
  void safe("subscribe", async () => {
    await getClient().subscribe(roomEl.value);
  });
});

document.querySelector<HTMLButtonElement>("#unsubscribe")!.addEventListener("click", () => {
  void safe("unsubscribe", async () => {
    await getClient().unsubscribe(roomEl.value);
  });
});

document.querySelector<HTMLButtonElement>("#publish")!.addEventListener("click", () => {
  void safe("publish", async () => {
    const payloadType = payloadTypeEl.value as PayloadType;
    await getClient().publish(roomEl.value, eventEl.value, parsePayload(payloadEl.value, payloadType), {
      queueIfDisconnected: false,
      payloadType,
    });
  });
});

document.querySelector<HTMLButtonElement>("#publishQueued")!.addEventListener("click", () => {
  void safe("publish_queued", async () => {
    const payloadType = payloadTypeEl.value as PayloadType;
    await getClient().publish(roomEl.value, eventEl.value, parsePayload(payloadEl.value, payloadType), {
      queueIfDisconnected: true,
      payloadType,
    });
  });
});

window.addEventListener("beforeunload", () => {
  client?.dispose();
});
