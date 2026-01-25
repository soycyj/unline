const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const BUILD = process.env.BUILD_ID || "unline-build-voice-draw-001";

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, "public");

/* html 캐시 방지 */
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

  res.json({ ok: true, build: BUILD, iceServers });
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

/* room store */
const rooms = new Map();
/*
room shape
{
  room,
  users Map clientId -> { ws, clientId, label, role, color, ready }
  participants Set clientId
  strokes Array stroke
}
*/

function getRoom(room) {
  let r = rooms.get(room);
  if (!r) {
    r = {
      room,
      users: new Map(),
      participants: new Set(),
      strokes: [],
    };
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
    ready: !!u.ready,
  }));
  return {
    type: "room_state",
    build: BUILD,
    visitors: r.users.size,
    users,
  };
}

function broadcast(r, payload, exceptClientId) {
  const s = JSON.stringify(payload);
  for (const u of r.users.values()) {
    if (exceptClientId && u.clientId === exceptClientId) continue;
    if (u.ws && u.ws.readyState === 1) u.ws.send(s);
  }
}

function sendTo(r, clientId, payload) {
  const u = r.users.get(clientId);
  if (!u) return;
  if (u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify(payload));
}

function isParticipant(r, clientId) {
  const u = r.users.get(clientId);
  return !!(u && u.role === "participant");
}

/* http + ws */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "ROOM").trim();
  const clientId = (url.searchParams.get("clientId") || genId("c")).trim();
  const label = (url.searchParams.get("label") || "").trim();

  const r = getRoom(room);

  /* participant auto assign teacher student first two */
  const isTeacher = label.toLowerCase() === "teacher";
  const isStudent = label.toLowerCase() === "student";

  let role = "viewer";
  if ((isTeacher || isStudent) && r.participants.size < 2) {
    role = "participant";
    r.participants.add(clientId);
  } else if (r.participants.size < 2 && !r.participants.has(clientId)) {
    role = "participant";
    r.participants.add(clientId);
  }

  const user = {
    ws,
    clientId,
    label: label || "User",
    role,
    ready: false,
    color: `hsl(${Math.floor(Math.random() * 360)},70%,60%)`,
  };

  r.users.set(clientId, user);

  /* send snapshot to new user */
  sendTo(r, clientId, { type: "canvas_snapshot", strokes: r.strokes, build: BUILD });

  /* broadcast state */
  broadcast(r, roomState(r));

  ws.on("message", (buf) => {
    const msg = safeJson(buf.toString("utf8"));
    if (!msg || !msg.type) return;

    const me = r.users.get(clientId);
    if (!me) return;

    /* drawing */
    if (msg.type === "draw") {
      if (!isParticipant(r, clientId)) return;

      const stroke = {
        type: "draw",
        a: msg.a,
        b: msg.b,
        mode: msg.mode || "pen",
        color: msg.color || "#e8eef9",
        w: Number(msg.w || 3),
      };

      if (!stroke.a || !stroke.b) return;

      r.strokes.push(stroke);

      /* safety cap */
      if (r.strokes.length > 5000) r.strokes.splice(0, r.strokes.length - 5000);

      broadcast(r, stroke, clientId);
      return;
    }

    if (msg.type === "clear") {
      if (!isParticipant(r, clientId)) return;
      r.strokes = [];
      broadcast(r, { type: "clear" });
      return;
    }

    /* ready */
    if (msg.type === "ready_set") {
      me.ready = !!msg.ready;
      broadcast(r, roomState(r));
      return;
    }

    /* role management */
    if (msg.type === "set_role") {
      if (!isParticipant(r, clientId)) return;

      const targetId = (msg.targetClientId || "").trim();
      const nextRole = msg.role === "participant" ? "participant" : "viewer";
      if (!targetId) return;

      const target = r.users.get(targetId);
      if (!target) return;

      if (nextRole === "participant") {
        if (r.participants.size >= 2 && !r.participants.has(targetId)) return;
        r.participants.add(targetId);
        target.role = "participant";
      } else {
        r.participants.delete(targetId);
        target.role = "viewer";
      }

      broadcast(r, roomState(r));
      return;
    }

    /* voice relay */
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
      if (!isParticipant(r, clientId)) return;

      const payload = { ...msg, fromClientId: clientId };

      for (const u of r.users.values()) {
        if (u.clientId === clientId) continue;
        if (u.role !== "participant") continue;
        if (u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify(payload));
      }
      return;
    }
  });

  ws.on("close", () => {
    r.users.delete(clientId);
    r.participants.delete(clientId);

    if (r.users.size === 0) {
      rooms.delete(room);
      return;
    }

    broadcast(r, roomState(r));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("unline server running", PORT, BUILD);
});
