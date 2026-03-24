import "./style.css";
import { SocketClient } from "@gosocket/client";
const app = document.querySelector("#app");
if (!app)
    throw new Error("#app not found");
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
      <input id="payload" value='{"title":"hello"}' placeholder='{"json":"payload"}' />
      <button id="emit">Emit Event</button>
      <button id="emitAck" class="warn">Emit with Ack</button>
    </div>

    <div class="log" id="log"></div>
  </div>
`;
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");
const urlEl = document.querySelector("#url");
const roomEl = document.querySelector("#room");
const eventEl = document.querySelector("#event");
const payloadEl = document.querySelector("#payload");
let client = null;
function log(line) {
    const stamp = new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "time";
    logEl.textContent += `[${stamp}] ${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}
function parsePayload(input) {
    try {
        return JSON.parse(input);
    }
    catch {
        return input; // fallback to string
    }
}
function attachClient(next) {
    next.onSys("state", (state) => {
        statusEl.textContent = `state: ${state}`;
        log(`state -> ${state}`);
    });
    next.onSys("open", () => log("open"));
    next.onSys("close", (info) => log(`close code=${info.code} reason=${info.reason || "<none>"} clean=${info.wasClean}`));
    next.onSys("error", (err) => log(`error: ${err.name}: ${err.message}`));
    next.onSys("reconnectAttempt", (a) => log(`reconnect attempt=${a.attempt} delay=${a.delayMs}ms`));
    // Catch-all arbitrary demo event listening
    next.on("message", (...args) => log(`message: ${JSON.stringify(args)}`));
    next.on("headline", (...args) => log(`headline: ${JSON.stringify(args)}`));
}
function getClient() {
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
async function safe(action, fn) {
    try {
        await fn();
        log(`${action}: ok`);
    }
    catch (err) {
        const e = err;
        log(`${action}: failed -> ${e.name}: ${e.message}`);
    }
}
document.querySelector("#connect").addEventListener("click", () => {
    void safe("connect", async () => {
        const c = getClient();
        await c.connect();
    });
});
document.querySelector("#disconnect").addEventListener("click", () => {
    void safe("disconnect", () => {
        client?.disconnect();
    });
});
document.querySelector("#subscribe").addEventListener("click", () => {
    void safe("subscribe", async () => {
        await getClient().emit("subscribe", roomEl.value);
    });
});
document.querySelector("#unsubscribe").addEventListener("click", () => {
    void safe("unsubscribe", async () => {
        await getClient().emit("unsubscribe", roomEl.value);
    });
});
document.querySelector("#emit").addEventListener("click", () => {
    void safe("emit", async () => {
        await getClient().emit(eventEl.value, parsePayload(payloadEl.value));
    });
});
document.querySelector("#emitAck").addEventListener("click", () => {
    void safe("emit_ack", async () => {
        await getClient().emit(eventEl.value, parsePayload(payloadEl.value), (res) => {
            log(`Ack received: ${JSON.stringify(res)}`);
        });
    });
});
window.addEventListener("beforeunload", () => {
    client?.dispose();
});
