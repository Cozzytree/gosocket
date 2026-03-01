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
      <button id="publish">Publish</button>
      <button id="publishQueued" class="warn">Publish (queue)</button>
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
        throw new Error("Payload must be valid JSON");
    }
}
function attachClient(next) {
    next.on("state", (state) => {
        statusEl.textContent = `state: ${state}`;
        log(`state -> ${state}`);
    });
    next.on("open", () => log("open"));
    next.on("close", (info) => log(`close code=${info.code} reason=${info.reason || "<none>"} clean=${info.wasClean}`));
    next.on("error", (err) => log(`error: ${err.name}: ${err.message}`));
    next.on("reconnectAttempt", (a) => log(`reconnect attempt=${a.attempt} delay=${a.delayMs}ms`));
    next.on("droppedMessage", (m) => log(`dropped queued message room=${m.room} event=${m.event}`));
    next.on("message", (msg) => log(`message: ${JSON.stringify(msg)}`));
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
        await getClient().subscribe(roomEl.value);
    });
});
document.querySelector("#unsubscribe").addEventListener("click", () => {
    void safe("unsubscribe", async () => {
        await getClient().unsubscribe(roomEl.value);
    });
});
document.querySelector("#publish").addEventListener("click", () => {
    void safe("publish", async () => {
        await getClient().publish(roomEl.value, eventEl.value, parsePayload(payloadEl.value), {
            queueIfDisconnected: false,
        });
    });
});
document.querySelector("#publishQueued").addEventListener("click", () => {
    void safe("publish_queued", async () => {
        await getClient().publish(roomEl.value, eventEl.value, parsePayload(payloadEl.value), {
            queueIfDisconnected: true,
        });
    });
});
window.addEventListener("beforeunload", () => {
    client?.dispose();
});
