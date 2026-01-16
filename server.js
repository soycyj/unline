import http from "http";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map();

// teachers and queue
const teachers = new Map(); // teacherId -> { status: waiting|matched, teacherUrl, updatedAt }
const teacherQueue = []; // FIFO

function now() { return Date.now(); }
function genId(prefix) { return prefix + Math.random().toString(16).slice(2, 10); }
function genRoomCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function getBase(req) { return req.protocol + "://" + req.get("host"); }

function getRoom(room) {
  if (!rooms.has(room)) {
    rooms.set(room, {
      sockets: new Set(),
      clientIdBySocket: new Map(),
      roleByClientId: new Map(),
      session: null, // { sessionId, mode: "trial"|"learning", trialEndsAt, teacherId, createdAt, learningStartedAt }
    });
  }
  return rooms.get(room);
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {}
}

function ensureRoles(roomState) {
  const entries = Array.from(roomState.roleByClientId.entries());
  const participants = entries.filter(([, r]) => r === "Participant").map(([id]) => id);

  if (participants.length > 2) {
    for (let i = 2; i < participants.length; i++) {
      roomState.roleByClientId.set(participants[i], "Viewer");
    }
  }

  let count = Array.from(roomState.roleByClientId.values()).filter(r => r === "Participant").length;
  if (count < 2) {
    for (const id of roomState.roleByClientId.keys()) {
      if (roomState.roleByClientId.get(id) !== "Participant") {
        roomState.roleByClientId.set(id, "Participant");
        count++;
        if (count >= 2) break;
      }
    }
  }

  for (const [id, r] of roomState.roleByClientId.entries()) {
    if (r !== "Participant" && r !== "Viewer") roomState.roleByClientId.set(id, "Viewer");
  }
}

function broadcastRoomState(roomState) {
  ensureRoles(roomState);
  const visitors = roomState.sockets.size;

  const sessionMode = roomState.session?.mode || null;
  const trialEndsAt = roomState.session?.trialEndsAt || null;
  const sessionId = roomState.session?.sessionId || null;

  for (const ws of roomState.sockets) {
    if (ws.readyState !== 1) continue;
    const clientId = roomState.clientIdBySocket.get(ws);
    const role = roomState.roleByClientId.get(clientId) || "Viewer";
    safeSend(ws, { type: "room_state", visitors, role, sessionMode, trialEndsAt, sessionId });
  }
}

function isParticipant(roomState, ws) {
  const clientId = roomState.clientIdBySocket.get(ws);
  const role = roomState.roleByClientId.get(clientId);
  return role === "Participant";
}

// teacher online
app.post("/api/teacher/online", (req, res) => {
  const teacherId = String(req.body?.teacherId || "").trim();
  if (!teacherId) return res.status(400).json({ ok: false, error: "missing teacherId" });

  const t = teachers.get(teacherId);
  if (!t || t.status !== "waiting") {
    teachers.set(teacherId, { status: "waiting", teacherUrl: null, updatedAt: now() });
    teacherQueue.push(teacherId);
  }
  return res.json({ ok: true });
});

app.post("/api/teacher/offline", (req, res) => {
  const teacherId = String(req.body?.teacherId || "").trim();
  if (!teacherId) return res.status(400).json({ ok: false, error: "missing teacherId" });

  teachers.delete(teacherId);
  return res.json({ ok: true });
});

// student match
app.post("/api/match", (req, res) => {
  let picked = null;
  while (teacherQueue.length) {
    const id = teacherQueue.shift();
    const t = teachers.get(id);
    if (t && t.status === "waiting") {
      picked = id;
      break;
    }
  }
  if (!picked) return res.json({ ok: false, reason: "no_teacher_available" });

  const base = getBase(req);
  const room = genRoomCode();
  const sessionId = genId("sess_");
  const trialEndsAt = now() + 10 * 60 * 1000;

  const teacherClientId = genId("t");
  const studentClientId = genId("s");

  const teacherUrl =
    `${base}/canvas.html?room=${encodeURIComponent(room)}` +
    `&clientId=${encodeURIComponent(teacherClientId)}` +
    `&label=${encodeURIComponent("Teacher")}` +
    `&teacherId=${encodeURIComponent(picked)}` +
    `&sessionId=${encodeURIComponent(sessionId)}`;

  const studentUrl =
    `${base}/canvas.html?room=${encodeURIComponent(room)}` +
    `&clientId=${encodeURIComponent(studentClientId)}` +
    `&label=${encodeURIComponent("Student")}` +
    `&sessionId=${encodeURIComponent(sessionId)}`;

  teachers.set(picked, { status: "matched", teacherUrl, updatedAt: now() });

  // create room + session meta
  const roomState = getRoom(room);
  roomState.session = {
    sessionId,
    mode: "trial",
    trialEndsAt,
    teacherId: picked,
    createdAt: now(),
    learningStartedAt: null,
  };

  return res.json({ ok: true, room, sessionId, trialEndsAt, teacherUrl, studentUrl });
});

// student decision after trial
// decision: continue | retry | end
app.post("/api/session/decision", (req, res) => {
  const room = String(req.body?.room || "").trim();
  const sessionId = String(req.body?.sessionId || "").trim();
  const decision = String(req.body?.decision || "").trim();

  if (!room || !sessionId || !decision) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  const roomState = rooms.get(room);
  if (!roomState || !roomState.session || roomState.session.sessionId !== sessionId) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  const teacherId = roomState.session.teacherId;

  if (decision === "continue") {
    roomState.session.mode = "learning";
    roomState.session.trialEndsAt = null;
    roomState.session.learningStartedAt = now();
    broadcastRoomState(roomState);
    return res.json({ ok: true, mode: "learning" });
  }

  // retry or end: teacher goes back to waiting, room session ends
  if (teacherId) {
    teachers.set(teacherId, { status: "waiting", teacherUrl: null, updatedAt: now() });
    teacherQueue.push(teacherId);
  }

  roomState.session = null;
  broadcastRoomState(roomState);

  return res.json({ ok: true, mode: "ended" });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "").trim() || "ROOM";
  const clientId = (url.searchParams.get("clientId") || "").trim() || ("c" + Math.random().toString(16).slice(2, 10));

  const roomState = getRoom(room);

  // reclaim
  for (const [sock, id] of roomState.clientIdBySocket.entries()) {
    if (id === clientId && sock !== ws) {
      try { sock.close(4001, "reclaimed"); } catch {}
      roomState.sockets.delete(sock);
      roomState.clientIdBySocket.delete(sock);
    }
  }

  roomState.sockets.add(ws);
  roomState.clientIdBySocket.set(ws, clientId);

  if (!roomState.roleByClientId.has(clientId)) {
    roomState.roleByClientId.set(clientId, "Viewer");
  }

  broadcastRoomState(roomState);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    const type = msg.type || "";

    if (type === "hello") {
      broadcastRoomState(roomState);
      return;
    }

    if (type === "draw" || type === "clear") {
      if (!isParticipant(roomState, ws)) return;
      for (const s of roomState.sockets) if (s !== ws) safeSend(s, msg);
      return;
    }

    const voiceTypes = new Set([
      "voice_request","voice_accept","voice_reject","voice_offer","voice_answer","voice_ice","voice_stop"
    ]);

    if (voiceTypes.has(type)) {
      if (!isParticipant(roomState, ws)) return;
      for (const s of roomState.sockets) if (s !== ws) safeSend(s, msg);
      return;
    }
  });

  ws.on("close", () => {
    roomState.sockets.delete(ws);
    roomState.clientIdBySocket.delete(ws);

    const stillAliveIds = new Set(Array.from(roomState.clientIdBySocket.values()));
    for (const id of Array.from(roomState.roleByClientId.keys())) {
      if (!stillAliveIds.has(id)) roomState.roleByClientId.delete(id);
    }

    if (roomState.sockets.size === 0) rooms.delete(room);
    else broadcastRoomState(roomState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Listening on", PORT));
