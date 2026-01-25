const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const BUILD = process.env.BUILD_ID || "voice-reset-001";

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, "public");

/* HTML 캐시 방지 */
app.use((req, res, next) => {
  const p = req.path || "";
  if (p === "/" || p.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
  next();
});

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, build: BUILD });
});

/* Metered TURN */
app.get("/api/ice", (req, res) => {
  const urlsRaw = process.env.METERED_TURN_URLS || "";
  const username = process.env.METERED_TURN_USERNAME || "";
  const credential = process.env.METERED_TURN_CREDENTIAL || "";

  const urls = urlsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
  if (urls.length && username && credential) {
    iceServers.push({ urls, username, credential });
  }
  res.json({ ok: true, iceServers, build: BUILD });
});

function genId(prefix) {
  return prefix + Math.random().toString(16).slice(2, 10);
}
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* Rooms */
const rooms = new Map();
function getRoom(room) {
  let r = rooms.get(room);
  if (!r) {
    r = { room, users: new Map(), participants: new Set() };
    rooms.set(room, r);
  }
  return r;
}
function roomState(r) {
  const users = Array.from(r.users.values()).map((u) => ({
    clientId: u.clientId,
    label: u.label,
    role: u.role,
    color: u.color,
  }));
  return { type: "room_state", visitors: r.users.size, users, build: BUILD };
}
function broadcast(r, payload) {
  const s = JSON.stringify(payload);
  for (const u of r.users.values()) {
    if (u.ws && u.ws.readyState === 1) u.ws.send(s);
  }
}

/* HTTP + WS */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "VOICE01").trim();
  const clientId = (url.searchParams.get("clientId") || genId("c")).trim();
  const label = (url.searchParams.get("label") || "").trim();

  const r = getRoom(room);

  const isTeacher = label.toLowerCase() === "teacher";
  const isStudent = label.toLowerCase() === "student";

  /* teacher student는 무조건 participant 우선 배정 */
  let role = "viewer";
  if ((isTeacher || isStudent) && r.participants.size < 2) {
    role = "participant";
    r.participants.add(clientId);
  } else if (r.participants.size === 0) {
    role = "participant";
    r.participants.add(clientId);
  }

  const user = {
    ws,
    clientId,
    label,
    role,
    color: `hsl(${Math.floor(Math.random() * 360)},70%,60%)`,
  };

  r.users.set(clientId, user);
  broadcast(r, roomState(r));

  ws.on("message", (buf) => {
    const msg = safeJson(buf.toString("utf8"));
    if (!msg || !msg.type) return;

    const me = r.users.get(clientId);
    if (!me) return;

    const voiceTypes = new Set([
      "voice_request",
      "voice_accept",
      "voice_reject",
      "voice_offer",
      "voice_answer",
      "voice_ice",
      "voice_stop",
    ]);

    if (voiceTypes.has(msg.type)) {
      if (me.role !== "participant") return;

      const payload = { ...msg, fromClientId: clientId };
      for (const u of r.users.values()) {
        if (u.clientId === clientId) continue;
        if (u.role !== "participant") continue;
        if (u.ws && u.ws.readyState === 1) {
          u.ws.send(JSON.stringify(payload));
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    r.users.delete(clientId);
    r.participants.delete(clientId);
    if (r.users.size === 0) rooms.delete(room);
    else broadcast(r, roomState(r));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("unline server running", PORT, BUILD));
