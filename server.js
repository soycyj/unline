const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, "public");

/* no cache for html so GitHub edits reflect immediately */
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

/* =========================
   Helpers
========================= */
function nowMs() {
  return Date.now();
}
function genRoomCode() {
  return Math.random().toString(16).slice(2, 8).toUpperCase();
}
function genClientId(prefix) {
  return prefix + Math.random().toString(16).slice(2, 10);
}
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* =========================
   Metered TURN for WebRTC
   Render env keys
   METERED_TURN_URLS
   METERED_TURN_USERNAME
   METERED_TURN_CREDENTIAL
========================= */
app.get("/api/ice", (req, res) => {
  try {
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

    return res.json({ ok: true, iceServers });
  } catch {
    return res.json({
      ok: true,
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });
  }
});

/* =========================
   Teacher Student matching
========================= */
const waitingTeachers = new Map();

function buildTeacherUrl(roomCode, teacherClientId) {
  return `/canvas.html?room=${encodeURIComponent(roomCode)}&clientId=${encodeURIComponent(
    teacherClientId
  )}&label=${encodeURIComponent("Teacher")}`;
}
function buildStudentUrl(roomCode, studentClientId) {
  return `/canvas.html?room=${encodeURIComponent(roomCode)}&clientId=${encodeURIComponent(
    studentClientId
  )}&label=${encodeURIComponent("Student")}`;
}

app.post("/api/teacher/online", (req, res) => {
  const teacherId = (req.body && req.body.teacherId) || "";
  if (!teacherId) return res.status(400).json({ ok: false });

  const existing = waitingTeachers.get(teacherId);
  if (existing && (existing.status === "waiting" || existing.status === "matched")) {
    return res.json({ ok: true, status: existing.status });
  }

  const roomCode = genRoomCode();
  const teacherClientId = genClientId("t");

  waitingTeachers.set(teacherId, {
    status: "waiting",
    roomCode,
    teacherClientId,
    createdAt: nowMs(),
    matchedAt: null,
  });

  return res.json({ ok: true, status: "waiting" });
});

app.post("/api/teacher/poll", (req, res) => {
  const teacherId = (req.body && req.body.teacherId) || "";
  if (!teacherId) return res.status(400).json({ ok: false });

  const t = waitingTeachers.get(teacherId);
  if (!t) return res.json({ ok: true, status: "offline" });

  if (t.status === "matched") {
    return res.json({
      ok: true,
      status: "matched",
      teacherUrl: buildTeacherUrl(t.roomCode, t.teacherClientId),
    });
  }

  return res.json({ ok: true, status: "waiting" });
});

app.post("/api/teacher/offline", (req, res) => {
  const teacherId = (req.body && req.body.teacherId) || "";
  if (!teacherId) return res.status(400).json({ ok: false });
  waitingTeachers.delete(teacherId);
  return res.json({ ok: true });
});

app.post("/api/match", (req, res) => {
  let pickedTeacherId = null;
  let picked = null;

  for (const [tid, t] of waitingTeachers.entries()) {
    if (!t || t.status !== "waiting") continue;
    if (!picked || t.createdAt < picked.createdAt) {
      picked = t;
      pickedTeacherId = tid;
    }
  }

  if (!picked || !pickedTeacherId) return res.json({ ok: false });

  const studentClientId = genClientId("s");
  picked.status = "matched";
  picked.matchedAt = nowMs();
  waitingTeachers.set(pickedTeacherId, picked);

  return res.json({
    ok: true,
    studentUrl: buildStudentUrl(picked.roomCode, studentClientId),
  });
});

/* =========================
   Rooms realtime state
========================= */
const rooms = new Map();

function getRoom(roomCode) {
  let r = rooms.get(roomCode);
  if (!r) {
    r = {
      room: roomCode,
      users: new Map(),
      participants: new Set(),
      strokes: [],
      sessionState: "waiting",
      trialEndsAt: null,
      ownerId: null,
    };
    rooms.set(roomCode, r);
  }
  return r;
}

function listUsers(r) {
  return Array.from(r.users.values()).map((u) => ({
    clientId: u.clientId,
    label: u.label,
    role: u.role,
    color: u.color,
    kind: u.kind,
  }));
}

function broadcastRoomState(r) {
  const payload = {
    type: "room_state",
    visitors: r.users.size,
    users: listUsers(r),
    sessionState: r.sessionState,
    trialEndsAt: r.trialEndsAt,
    ownerId: r.ownerId,
  };
  for (const u of r.users.values()) {
    if (u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoomAll(r, payload) {
  for (const u of r.users.values()) {
    if (u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify(payload));
  }
}

/* =========================
   HTTP server and WS server
========================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomCode = (url.searchParams.get("room") || "TEST").trim();
  const clientId = (url.searchParams.get("clientId") || genClientId("c")).trim();
  const labelRaw = (url.searchParams.get("label") || "").trim();

  const label = labelRaw.toLowerCase();
  const kind = label === "teacher" ? "teacher" : label === "student" ? "student" : null;

  const r = getRoom(roomCode);

  /* Role assignment
     teacher and student get participant seats first max 2
     else if room empty first joiner becomes participant
  */
  let role = "viewer";
  if ((kind === "teacher" || kind === "student") && r.participants.size < 2) {
    role = "participant";
    r.participants.add(clientId);
    if (!r.ownerId) r.ownerId = clientId;
  } else if (r.participants.size === 0) {
    role = "participant";
    r.participants.add(clientId);
    r.ownerId = clientId;
  }

  const user = {
    ws,
    clientId,
    label: labelRaw,
    kind,
    role,
    color: `hsl(${Math.floor(Math.random() * 360)},70%,60%)`,
    ready: false,
    joinedAt: nowMs(),
  };

  r.users.set(clientId, user);

  ws.send(JSON.stringify({ type: "canvas_snapshot", strokes: r.strokes }));
  broadcastRoomState(r);

  ws.on("message", (buf) => {
    const msg = safeJsonParse(buf.toString("utf8"));
    if (!msg || !msg.type) return;

    const me = r.users.get(clientId);
    if (!me) return;

    if (msg.type === "hello") {
      ws.send(JSON.stringify({ type: "canvas_snapshot", strokes: r.strokes }));
      broadcastRoomState(r);
      return;
    }

    if (msg.type === "draw") {
      if (me.role !== "participant") return;
      const stroke = {
        type: "draw",
        a: msg.a,
        b: msg.b,
        mode: msg.mode,
        color: msg.color,
        w: msg.w,
      };
      r.strokes.push(stroke);
      broadcastToRoomAll(r, stroke);
      return;
    }

    if (msg.type === "clear") {
      if (me.role !== "participant") return;
      r.strokes = [];
      broadcastToRoomAll(r, { type: "clear" });
      return;
    }

    if (msg.type === "set_role") {
      if (me.role !== "participant") return;

      const targetId = msg.targetClientId;
      const nextRole = msg.role === "participant" ? "participant" : "viewer";
      const target = r.users.get(targetId);
      if (!target) return;

      if (nextRole === "participant") {
        if (r.participants.size >= 2 && !r.participants.has(targetId)) return;
        r.participants.add(targetId);
        target.role = "participant";
        if (!r.ownerId) r.ownerId = targetId;
      } else {
        r.participants.delete(targetId);
        target.role = "viewer";
        if (r.ownerId === targetId) r.ownerId = Array.from(r.participants)[0] || null;
      }

      broadcastRoomState(r);
      return;
    }

    if (msg.type === "ready_set") {
      const ready = !!msg.ready;
      me.ready = ready;

      const participants = Array.from(r.users.values()).filter((u) => u.role === "participant");
      const readyCount = participants.filter((u) => u.ready).length;

      if (participants.length < 2) {
        r.sessionState = readyCount ? "ready_partial" : "waiting";
      } else {
        if (readyCount === 0) r.sessionState = "waiting";
        else if (readyCount === 1) r.sessionState = "ready_partial";
        else {
          r.sessionState = "trial_running";
          r.trialEndsAt = nowMs() + 10 * 60 * 1000;
        }
      }

      if (r.sessionState === "trial_running" && r.trialEndsAt && nowMs() >= r.trialEndsAt) {
        r.sessionState = "trial_ended";
      }

      broadcastRoomState(r);
      return;
    }

    /* Voice signaling relay between participants */
    if (
      msg.type === "voice_request" ||
      msg.type === "voice_accept" ||
      msg.type === "voice_reject" ||
      msg.type === "voice_offer" ||
      msg.type === "voice_answer" ||
      msg.type === "voice_ice" ||
      msg.type === "voice_stop"
    ) {
      if (me.role !== "participant") return;

      const payload = { ...msg, fromClientId: clientId, type: msg.type };

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

    if (r.ownerId === clientId) r.ownerId = Array.from(r.participants)[0] || null;

    if (r.users.size === 0) {
      rooms.delete(roomCode);
      return;
    }

    broadcastRoomState(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("unline server running on", PORT);
});
