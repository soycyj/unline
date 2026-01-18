import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import crypto from "crypto";

const __dirname = new URL(".", import.meta.url).pathname;
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* =====================
   Utilities
===================== */
const nowMs = () => Date.now();
const uid = () => crypto.randomBytes(8).toString("hex");

/* =====================
   TURN ICE (Metered)
===================== */
app.get("/api/ice", (req, res) => {
  try {
    const urlsRaw = process.env.METERED_TURN_URLS || "";
    const username = process.env.METERED_TURN_USERNAME || "";
    const credential = process.env.METERED_TURN_CREDENTIAL || "";

    const urls = urlsRaw.split(",").map(v => v.trim()).filter(Boolean);

    const iceServers = [
      { urls: ["stun:stun.l.google.com:19302"] }
    ];

    if (urls.length && username && credential) {
      iceServers.push({ urls, username, credential });
    }

    res.json({ ok: true, iceServers });
  } catch {
    res.json({
      ok: true,
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
    });
  }
});

/* =====================
   Teacher Student Match
===================== */
const waitingTeachers = new Map();

app.post("/api/teacher/online", (req, res) => {
  const { teacherId } = req.body;
  if (!teacherId) return res.status(400).json({ ok: false });

  if (waitingTeachers.has(teacherId)) {
    return res.json({ ok: true });
  }

  waitingTeachers.set(teacherId, {
    room: uid().slice(0, 6).toUpperCase(),
    createdAt: nowMs()
  });

  res.json({ ok: true });
});

app.post("/api/teacher/poll", (req, res) => {
  const { teacherId } = req.body;
  const t = waitingTeachers.get(teacherId);
  if (!t) return res.json({ ok: true, status: "offline" });

  if (t.matched) {
    return res.json({
      ok: true,
      status: "matched",
      teacherUrl: `/canvas.html?room=${t.room}&label=Teacher`
    });
  }

  res.json({ ok: true, status: "waiting" });
});

app.post("/api/teacher/offline", (req, res) => {
  const { teacherId } = req.body;
  waitingTeachers.delete(teacherId);
  res.json({ ok: true });
});

app.post("/api/match", (req, res) => {
  const entry = [...waitingTeachers.entries()]
    .find(([_, v]) => !v.matched);

  if (!entry) return res.json({ ok: false });

  const [teacherId, t] = entry;
  t.matched = true;
  waitingTeachers.set(teacherId, t);

  res.json({
    ok: true,
    studentUrl: `/canvas.html?room=${t.room}&label=Student`
  });
});

/* =====================
   Rooms State
===================== */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      strokes: [],
      sessionState: "waiting",
      ready: new Set(),
      trialEndsAt: null
    });
  }
  return rooms.get(roomId);
}

function broadcast(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const u of room.users.values()) {
    if (u.ws.readyState === 1) {
      u.ws.send(JSON.stringify(msg));
    }
  }
}

function roomSnapshot(roomId) {
  const r = rooms.get(roomId);
  if (!r) return {};
  return {
    visitors: r.users.size,
    users: [...r.users.values()].map(u => ({
      clientId: u.clientId,
      role: u.role,
      color: u.color
    })),
    sessionState: r.sessionState,
    trialEndsAt: r.trialEndsAt
  };
}

/* =====================
   WebSocket
===================== */
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const roomId = url.searchParams.get("room");
  const clientId = url.searchParams.get("clientId") || uid();
  const label = url.searchParams.get("label") || "";

  const room = getRoom(roomId);

  const user = {
    ws,
    clientId,
    label,
    role: room.users.size === 0 ? "participant" : "viewer",
    color: `hsl(${Math.random() * 360},70%,60%)`
  };

  room.users.set(clientId, user);

  ws.send(JSON.stringify({ type: "canvas_snapshot", strokes: room.strokes }));
  broadcast(roomId, { type: "room_state", ...roomSnapshot(roomId) });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "draw":
        room.strokes.push(msg);
        broadcast(roomId, msg);
        break;

      case "clear":
        room.strokes = [];
        broadcast(roomId, { type: "clear" });
        break;

      case "set_role":
        if (user.role !== "participant") return;
        const target = room.users.get(msg.targetClientId);
        if (target) target.role = msg.role;
        broadcast(roomId, { type: "room_state", ...roomSnapshot(roomId) });
        break;

      case "ready_set":
        if (msg.ready) room.ready.add(clientId);
        else room.ready.delete(clientId);

        if (room.ready.size >= 2 && room.sessionState === "waiting") {
          room.sessionState = "trial_running";
          room.trialEndsAt = nowMs() + 10 * 60 * 1000;
        }

        broadcast(roomId, { type: "room_state", ...roomSnapshot(roomId) });
        break;

      case "voice_request":
      case "voice_accept":
      case "voice_reject":
      case "voice_offer":
      case "voice_answer":
      case "voice_ice":
      case "voice_stop":
        broadcast(roomId, { ...msg, clientId });
        break;
    }
  });

  ws.on("close", () => {
    room.users.delete(clientId);
    room.ready.delete(clientId);
    broadcast(roomId, { type: "room_state", ...roomSnapshot(roomId) });
  });
});

/* =====================
   Start
===================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("unline server running on", PORT);
});
