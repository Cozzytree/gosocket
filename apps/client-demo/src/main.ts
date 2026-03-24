import "./style.css";
import { SocketClient } from "@gosocket/client";

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="panel">
    <div class="panel-header">
      <h1>gosocket <span class="badge">demo</span></h1>
      <div class="meta">
        <span class="status-dot" id="dot"></span>
        <span class="status-text" id="status">idle</span>
        <span class="queue-badge" id="queue" title="queued packets">queue: 0</span>
      </div>
    </div>

    <section class="section">
      <label class="section-label">Connection</label>
      <div class="row">
        <input id="url" value="ws://localhost:8080/ws" placeholder="ws://…" />
        <button id="connect">Connect</button>
        <button id="disconnect" class="secondary">Disconnect</button>
        <button id="dispose" class="danger">Dispose</button>
      </div>
    </section>

    <section class="section">
      <label class="section-label">Rooms</label>
      <div class="row">
        <input id="room" value="news" placeholder="room name" />
        <button id="join">Join Room</button>
        <button id="leave" class="secondary">Leave Room</button>
      </div>
      <div class="chip-row" id="rooms-active">
        <span class="chip-label">active rooms:</span>
      </div>
    </section>

    <section class="section">
      <label class="section-label">Emit Event</label>
      <div class="row">
        <input id="event" value="headline" placeholder="event name" />
        <input id="payload" value='{"title":"hello world"}' placeholder='{"json":"payload"}' />
        <button id="emit">Emit</button>
        <button id="emitAck" class="accent">Emit + Ack</button>
      </div>
    </section>

    <section class="section">
      <label class="section-label">Broadcast to Room</label>
      <div class="row">
        <input id="bcast-room" value="news" placeholder="room" />
        <input id="bcast-payload" value='{"msg":"hello everyone"}' placeholder='{"json":"payload"}' />
        <button id="broadcast" class="accent">Broadcast</button>
      </div>
    </section>

    <section class="section">
      <div class="log-header">
        <label class="section-label">Event Log</label>
        <button id="clear-log" class="ghost">Clear</button>
      </div>
      <div class="log" id="log"></div>
    </section>
  </div>
`;

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------

const dotEl     = document.querySelector<HTMLSpanElement>("#dot")!;
const statusEl  = document.querySelector<HTMLSpanElement>("#status")!;
const queueEl   = document.querySelector<HTMLSpanElement>("#queue")!;
const logEl     = document.querySelector<HTMLDivElement>("#log")!;
const urlEl     = document.querySelector<HTMLInputElement>("#url")!;
const roomEl    = document.querySelector<HTMLInputElement>("#room")!;
const eventEl   = document.querySelector<HTMLInputElement>("#event")!;
const payloadEl = document.querySelector<HTMLInputElement>("#payload")!;
const bcastRoom = document.querySelector<HTMLInputElement>("#bcast-room")!;
const bcastPay  = document.querySelector<HTMLInputElement>("#bcast-payload")!;
const roomsRow  = document.querySelector<HTMLDivElement>("#rooms-active")!;

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

type LogLevel = "info" | "ok" | "error" | "event" | "warn" | "sys";

function log(line: string, level: LogLevel = "info"): void {
  const now = new Date();
  const ts = now.toTimeString().split(" ")[0]!;
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const el = document.createElement("div");
  el.className = `log-line log-${level}`;
  el.textContent = `[${ts}.${ms}] ${line}`;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

document.querySelector<HTMLButtonElement>("#clear-log")!.addEventListener("click", () => {
  logEl.innerHTML = "";
});

// ---------------------------------------------------------------------------
// State chip rendering
// ---------------------------------------------------------------------------

const STATE_DOT: Record<string, string> = {
  idle: "dot-idle", connecting: "dot-connecting", open: "dot-open",
  closing: "dot-closing", closed: "dot-closed", disposed: "dot-disposed",
};

function updateStatusUI(state: string): void {
  dotEl.className = `status-dot ${STATE_DOT[state] ?? "dot-idle"}`;
  statusEl.textContent = state;
}

function updateQueueUI(): void {
  const n = client?.queueSize ?? 0;
  queueEl.textContent = `queue: ${n}`;
  queueEl.classList.toggle("queue-nonzero", n > 0);
}

// ---------------------------------------------------------------------------
// Active rooms chips
// ---------------------------------------------------------------------------

const activeRooms = new Set<string>();

function addRoomChip(room: string): void {
  activeRooms.add(room);
  renderRoomChips();
}

function removeRoomChip(room: string): void {
  activeRooms.delete(room);
  renderRoomChips();
}

function renderRoomChips(): void {
  // Clear existing chips but keep the label.
  const label = roomsRow.querySelector(".chip-label")!;
  roomsRow.innerHTML = "";
  roomsRow.appendChild(label);

  for (const r of activeRooms) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = r;
    roomsRow.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let client: SocketClient | null = null;

function parsePayload(input: string): unknown {
  try { return JSON.parse(input); }
  catch { return input; }
}

function attachClient(c: SocketClient): void {
  c.onSys("state", (state) => {
    updateStatusUI(state);
    log(`state → ${state}`, "sys");
    updateQueueUI();
  });

  c.onSys("open",  () => { log("connected", "ok"); updateQueueUI(); });
  c.onSys("close", (info) => {
    log(`closed  code=${info.code}  reason=${info.reason || "<none>"}  clean=${info.wasClean}`, "warn");
    activeRooms.clear();
    renderRoomChips();
    updateQueueUI();
  });
  c.onSys("error",           (err) => log(`${err.name}: ${err.message}`, "error"));
  c.onSys("reconnectAttempt", (a)  => log(`reconnect #${a.attempt}  delay=${a.delayMs}ms`, "warn"));

  // Server-pushed events.
  c.on("welcome",  (...args) => log(`welcome  ${JSON.stringify(args)}`, "event"));
  c.on("message",  (...args) => log(`message  ${JSON.stringify(args)}`, "event"));
  c.on("headline", (...args) => log(`headline ${JSON.stringify(args)}`, "event"));
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
      queue: { maxSize: 100, dropPolicy: "oldest" },
    });
    attachClient(client);
    updateStatusUI("idle");
  }
  return client;
}

// ---------------------------------------------------------------------------
// Safe wrapper
// ---------------------------------------------------------------------------

async function safe(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    updateQueueUI();
    log(`${label}: ok`, "ok");
  } catch (err) {
    const e = err as Error;
    log(`${label}: ${e.name}: ${e.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

document.querySelector("#connect")!.addEventListener("click", () =>
  safe("connect", () => getClient().connect()),
);

document.querySelector("#disconnect")!.addEventListener("click", () =>
  safe("disconnect", () => {
    client?.disconnect();
  }),
);

document.querySelector("#dispose")!.addEventListener("click", () =>
  safe("dispose", () => {
    client?.dispose();
    client = null;
    activeRooms.clear();
    renderRoomChips();
    updateStatusUI("disposed");
    updateQueueUI();
  }),
);

document.querySelector("#join")!.addEventListener("click", () =>
  safe("join", async () => {
    const room = roomEl.value.trim();
    getClient().joinRoom(room);
    addRoomChip(room);
    log(`join room=${room}`, "info");
  }),
);

document.querySelector("#leave")!.addEventListener("click", () =>
  safe("leave", () => {
    const room = roomEl.value.trim();
    getClient().leaveRoom(room);
    removeRoomChip(room);
    log(`leave room=${room}`, "info");
  }),
);

document.querySelector("#emit")!.addEventListener("click", () =>
  safe("emit", () =>
    getClient().emit(eventEl.value, parsePayload(payloadEl.value)),
  ),
);

document.querySelector("#emitAck")!.addEventListener("click", () =>
  safe("emit+ack", () =>
    getClient().emit(eventEl.value, parsePayload(payloadEl.value), (...res: any[]) => {
      log(`ack received: ${JSON.stringify(res)}`, "ok");
    }),
  ),
);

document.querySelector("#broadcast")!.addEventListener("click", () =>
  safe("broadcast", () =>
    getClient().emit("broadcast", bcastRoom.value.trim(), parsePayload(bcastPay.value), (...res: any[]) => {
      log(`broadcast ack: ${JSON.stringify(res)}`, "ok");
    }),
  ),
);

// ---------------------------------------------------------------------------
// Cleanup on page unload
// ---------------------------------------------------------------------------

window.addEventListener("beforeunload", () => client?.dispose());
