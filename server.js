// server.js  CommonJS version, do not use type module

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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
function pickOldestWaitingTeacher() {
  let pickedTeacherId = null;
  let picked = null;
  for (const [tid, t] of waitingTeachers.entries()) {
    if (!t) continue;
    if (t.status !== "waiting") continue;
    if (!picked || t.createdAt < picked.createdAt) {
      picked = t;
      pickedTeacherId = tid;
    }
  }
  return { pickedTeacherId, picked };
}

/* =========================
   ICE servers, Metered TURN
   Env keys on Render
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
  const body = req.body || {};
  const teacherId = body.teacherId;
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
    matchedAt: null,
    createdAt: nowMs(),
  });

  return res.json({ ok: true, status: "waiting" });
});

app.post("/api/teacher/poll", (req, res) => {
  const body = req.body || {};
  const teacherId = body.teacherId;
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
  const body = req.body || {};
  const teacherId = body.teacherId;
  if (!teacherId) return res.status(400).json({ ok: false });

  waitingTeachers.delete(teacherId);
  return res.json({ ok: true });
});

app.post("/api/match", (req, res) => {
  const { pickedTeacherId, picked } = pickOldestWaitingTeacher();

  if (!picked || !pickedTeacherId) {
    return res.json({ ok: false });
  }

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
   Rooms and realtime state
========================= */
const rooms = new Map();

function getRoom(roomCode) {
  let r = rooms.get(roomCode);
  if (!r) {
    r = {
      room: roomCode,
      users: new Map(), // clientId -> user
      participants: new Set(), // clientId
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
    if (u.ws && u.ws.readyState === 1) {
      u.ws.send(JSON.stringify(payload));
    }
  }
}

function broadcastToRoomExcept(r, exceptClientId, payload) {
  for (const u of r.users.values()) {
    if (u.clientId === exceptClientId) continue;
    if (u.ws && u.ws.readyState === 1) {
      u.ws.send(JSON.stringify(payload));
    }
  }
}

function broadcastToRoomAll(r, payload) {
  for (const u of r.users.values()) {
    if (u.ws && u.ws.readyState === 1) {
      u.ws.send(JSON.stringify(payload));
    }
  }
}

/* =========================
   HTTP server and WS server
========================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomCode = (url.searchParams.get("room") || "TEST").trim();
  const clientId = (url.searchParams.get("clientId") || genClientId("c")).trim();
  const labelRaw = (url.searchParams.get("label") || "").trim();

  const label = labelRaw.toLowerCase();
  const kind = label === "teacher" ? "teacher" : label === "student" ? "student" : null;

  const r = getRoom(roomCode);

  // Role assignment
  // Teacher and Student get participant seats first, max 2
  // If none are participant yet, first joiner becomes participant
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
    label: labelRaw || "",
    kind,
    role,
    color: `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`,
    joinedAt: nowMs(),
  };

  r.users.set(clientId, user);

  // Send current canvas snapshot to the new client
  ws.send(JSON.stringify({ type: "canvas_snapshot", strokes: r.strokes }));

  // Send room state to everyone
  broadcastRoomState(r);

  ws.on("message", (buf) => {
    const msg = safeJsonParse(buf.toString("utf8"));
    if (!msg || !msg.type) return;

    // Keep user role aligned with participants set
    // This matters if a participant reconnects
    const me = r.users.get(clientId);
    if (!me) return;

    if (msg.type === "hello") {
      // Send state again on hello
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
      } else {
        r.participants.delete(targetId);
        target.role = "viewer";
        if (r.ownerId === targetId) r.ownerId = null;
        if (!r.ownerId && r.participants.size) {
          r.ownerId = Array.from(r.participants)[0] || null;
        }
      }

      broadcastRoomState(r);
      return;
    }

    if (msg.type === "ready_set") {
      // Keep existing UI functionality without forcing voice to depend on it
      // Minimal implementation, does not block voice even if trial ended
      const ready = !!msg.ready;
      me.ready = ready;

      const participantCount = Array.from(r.users.values()).filter((u) => u.role === "participant").length;
      const readyCount = Array.from(r.users.values()).filter((u) => u.role === "participant" && u.ready).length;

      if (r.sessionState === "waiting") {
        if (readyCount === 0) r.sessionState = "waiting";
        else if (readyCount < Math.min(2, participantCount)) r.sessionState = "ready_partial";
        else {
          r.sessionState = "trial_running";
          r.trialEndsAt = nowMs() + 10 * 60 * 1000;
        }
      } else if (r.sessionState === "ready_partial") {
        if (readyCount === 0) r.sessionState = "waiting";
        else if (readyCount >= Math.min(2, participantCount)) {
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

    // Voice signaling
    // Relay only between participants
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

    if (r.ownerId === clientId) r.ownerId = null;
    if (!r.ownerId && r.participants.size) {
      r.ownerId = Array.from(r.participants)[0] || null;
    }

    // Cleanup waiting teacher record if desired, optional
    // We do not force teacher offline here because teacherId is separate

    // If room empty, keep it for now, or delete to save memory
    if (r.users.size === 0) {
      // Keep strokes for a bit or remove immediately
      // rooms.delete(roomCode);
    } else {
      broadcastRoomState(r);
    }
  });
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("unline server running on", PORT);
});
