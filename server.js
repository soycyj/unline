"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json({ limit: "1mb" }));

// public 폴더를 정적 파일 루트로 고정
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = process.env.PORT || 3000;

function nowMs() {
  return Date.now();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function pickColor(seed) {
  const colors = [
    "#60a5fa",
    "#f87171",
    "#34d399",
    "#a78bfa",
    "#fbbf24",
    "#fb7185",
    "#22c55e",
    "#38bdf8",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function buildRoom() {
  return {
    users: new Map(), // clientId -> { ws, role, color, kind, joinedAt }
    participants: new Set(), // clientId
    ready: new Set(), // clientId
    canvas: {
      strokes: [],
      updatedAt: nowMs(),
    },
    session: {
      state: "waiting", // waiting | ready_partial | trial_running | trial_ended | learning
      trialEndsAt: null,
      startedAt: null,
    },
    ownerId: null, // first participant
  };
}

const rooms = new Map(); // room -> roomObj

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) rooms.set(roomCode, buildRoom());
  return rooms.get(roomCode);
}

function deleteRoomIfEmpty(roomCode) {
  const r = rooms.get(roomCode);
  if (!r) return;
  if (r.users.size === 0) rooms.delete(roomCode);
}

function roomUserList(r) {
  const out = [];
  for (const [cid, u] of r.users.entries()) {
    out.push({
      clientId: cid,
      color: u.color,
      role: u.role,
    });
  }
  return out;
}

function broadcast(roomCode, msgObj) {
  const r = rooms.get(roomCode);
  if (!r) return;
  const payload = JSON.stringify(msgObj);
  for (const u of r.users.values()) {
    try {
      u.ws.send(payload);
    } catch {}
  }
}

function sendTo(roomCode, clientId, msgObj) {
  const r = rooms.get(roomCode);
  if (!r) return;
  const u = r.users.get(clientId);
  if (!u) return;
  try {
    u.ws.send(JSON.stringify(msgObj));
  } catch {}
}

function recomputeSessionState(r) {
  const readyCount = r.ready.size;
  if (r.session.state === "trial_running") return;

  if (r.session.state === "trial_ended") return;

  if (readyCount >= 2) {
    r.session.state = "trial_running";
    r.session.startedAt = nowMs();
    r.session.trialEndsAt = r.session.startedAt + 10 * 60 * 1000;
    scheduleTrialEnd(r);
    return;
  }

  if (readyCount === 1) {
    r.session.state = "ready_partial";
    r.session.trialEndsAt = null;
    r.session.startedAt = null;
    return;
  }

  r.session.state = "waiting";
  r.session.trialEndsAt = null;
  r.session.startedAt = null;
}

function scheduleTrialEnd(r) {
  const endsAt = r.session.trialEndsAt;
  if (!endsAt) return;

  const delay = Math.max(0, endsAt - nowMs());
  setTimeout(() => {
    if (r.session.state !== "trial_running") return;
    if (!r.session.trialEndsAt) return;
    if (nowMs() + 50 < r.session.trialEndsAt) return;

    r.session.state = "trial_ended";
    broadcast(r._roomCode, {
      type: "room_state",
      visitors: r.users.size,
      users: roomUserList(r),
      sessionState: r.session.state,
      trialEndsAt: r.session.trialEndsAt,
    });
  }, delay);
}

function attachRoomCode(r, roomCode) {
  r._roomCode = roomCode;
}

/*
  TURN ICE servers are provided from env as JSON

  Example TURN_ICE_SERVERS value
  [
    {"urls":["stun:stun.relay.metered.ca:80"]},
    {"urls":["turn:global.relay.metered.ca:80"],"username":"...","credential":"..."},
    {"urls":["turn:global.relay.metered.ca:80?transport=tcp"],"username":"...","credential":"..."},
    {"urls":["turn:global.relay.metered.ca:443"],"username":"...","credential":"..."},
    {"urls":["turns:global.relay.metered.ca:443?transport=tcp"],"username":"...","credential":"..."}
  ]
*/
app.get("/api/ice", (req, res) => {
  const raw = process.env.TURN_ICE_SERVERS || "[]";
  const iceServers = safeJsonParse(raw, []);
  res.json({ ok: true, iceServers });
});

app.post("/api/session/decision", (req, res) => {
  const { room, decision, clientId } = req.body || {};
  if (!room || !decision) return res.status(400).json({ ok: false });

  const r = rooms.get(room);
  if (!r) return res.json({ ok: false });

  // decision은 kind=student 로 들어온 사람만 허용
  // kind는 ws query label=Student 에서만 설정
  const u = clientId ? r.users.get(clientId) : null;
  if (!u || u.kind !== "student") return res.json({ ok: false });

  if (decision === "continue") {
    r.session.state = "learning";
    broadcast(room, {
      type: "room_state",
      visitors: r.users.size,
      users: roomUserList(r),
      sessionState: r.session.state,
      trialEndsAt: r.session.trialEndsAt,
    });
    return res.json({ ok: true });
  }

  if (decision === "retry" || decision === "end") {
    // MVP에서는 단순히 trial_ended 유지
    return res.json({ ok: true });
  }

  return res.json({ ok: false });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomCode = (url.searchParams.get("room") || "TEST").trim();
  const clientId = (url.searchParams.get("clientId") || "").trim() || ("c" + Math.random().toString(16).slice(2, 10));
  const label = (url.searchParams.get("label") || "").trim().toLowerCase();

  const r = getRoom(roomCode);
  attachRoomCode(r, roomCode);

  const color = pickColor(clientId);

  // role assign
  let role = "viewer";
  if (r.participants.size === 0) {
    role = "participant";
    r.participants.add(clientId);
    r.ownerId = clientId;
  }

  const kind = label === "student" ? "student" : label === "teacher" ? "teacher" : null;

  r.users.set(clientId, {
    ws,
    role,
    color,
    kind,
    joinedAt: nowMs(),
  });

  // send initial state
  sendTo(roomCode, clientId, {
    type: "room_state",
    visitors: r.users.size,
    users: roomUserList(r),
    role,
    color,
    sessionState: r.session.state,
    trialEndsAt: r.session.trialEndsAt,
    ownerId: r.ownerId,
  });

  // send canvas snapshot
  sendTo(roomCode, clientId, {
    type: "canvas_snapshot",
    strokes: r.canvas.strokes,
    updatedAt: r.canvas.updatedAt,
  });

  // broadcast join update
  broadcast(roomCode, {
    type: "room_state",
    visitors: r.users.size,
    users: roomUserList(r),
    sessionState: r.session.state,
    trialEndsAt: r.session.trialEndsAt,
    ownerId: r.ownerId,
  });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    const me = r.users.get(clientId);
    if (!me) return;

    if (msg.type === "hello") {
      sendTo(roomCode, clientId, {
        type: "room_state",
        visitors: r.users.size,
        users: roomUserList(r),
        role: me.role,
        color: me.color,
        sessionState: r.session.state,
        trialEndsAt: r.session.trialEndsAt,
        ownerId: r.ownerId,
      });
      return;
    }

    if (msg.type === "set_role") {
      if (me.role !== "participant") return;
      const targetId = (msg.targetClientId || "").trim();
      const nextRole = (msg.role || "").trim();
      if (!targetId) return;
      const target = r.users.get(targetId);
      if (!target) return;
      if (nextRole !== "participant" && nextRole !== "viewer") return;

      target.role = nextRole;
      if (nextRole === "participant") r.participants.add(targetId);
      else r.participants.delete(targetId);

      // 최소 한 명 participant 보장
      if (r.participants.size === 0) {
        target.role = "participant";
        r.participants.add(targetId);
      }

      broadcast(roomCode, {
        type: "room_state",
        visitors: r.users.size,
        users: roomUserList(r),
        sessionState: r.session.state,
        trialEndsAt: r.session.trialEndsAt,
        ownerId: r.ownerId,
      });
      return;
    }

    if (msg.type === "ready_set") {
      const v = !!msg.ready;
      if (v) r.ready.add(clientId);
      else r.ready.delete(clientId);

      recomputeSessionState(r);

      broadcast(roomCode, {
        type: "room_state",
        visitors: r.users.size,
        users: roomUserList(r),
        sessionState: r.session.state,
        trialEndsAt: r.session.trialEndsAt,
        ownerId: r.ownerId,
        readyCount: r.ready.size,
      });
      return;
    }

    if (msg.type === "draw") {
      if (me.role !== "participant") return;
      if (!msg.a || !msg.b) return;

      const stroke = {
        a: msg.a,
        b: msg.b,
        mode: msg.mode || "pen",
        color: msg.color || me.color,
        w: Number(msg.w || 3),
      };

      r.canvas.strokes.push(stroke);
      if (r.canvas.strokes.length > 20000) r.canvas.strokes.splice(0, 2000);
      r.canvas.updatedAt = nowMs();

      broadcast(roomCode, { type: "draw", ...stroke });
      return;
    }

    if (msg.type === "clear") {
      if (me.role !== "participant") return;
      r.canvas.strokes = [];
      r.canvas.updatedAt = nowMs();
      broadcast(roomCode, { type: "clear" });
      return;
    }

    // voice signaling relay, participant only
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

      // relay to other participants only
      for (const [cid, u] of r.users.entries()) {
        if (cid === clientId) continue;
        if (u.role !== "participant") continue;
        try {
          u.ws.send(JSON.stringify({ ...msg, from: clientId }));
        } catch {}
      }
      return;
    }
  });

  ws.on("close", () => {
    const u = r.users.get(clientId);
    if (u) {
      r.users.delete(clientId);
      r.participants.delete(clientId);
      r.ready.delete(clientId);

      // owner가 나가면 남은 사람 중 첫 participant를 owner로
      if (r.ownerId === clientId) {
        const first = [...r.participants][0] || null;
        r.ownerId = first;
      }

      // participants 없으면 첫 사용자에게 participant 부여
      if (r.participants.size === 0) {
        const firstUser = [...r.users.keys()][0];
        if (firstUser) {
          const uu = r.users.get(firstUser);
          uu.role = "participant";
          r.participants.add(firstUser);
          if (!r.ownerId) r.ownerId = firstUser;
        }
      }

      // trial 중 ready 상태 재정리
      recomputeSessionState(r);

      broadcast(roomCode, {
        type: "room_state",
        visitors: r.users.size,
        users: roomUserList(r),
        sessionState: r.session.state,
        trialEndsAt: r.session.trialEndsAt,
        ownerId: r.ownerId,
      });
    }

    // 마지막 사람이 나가면 room 삭제, 다음 입장 시 초기화
    if (r.users.size === 0) {
      rooms.delete(roomCode);
    }
  });
});

server.listen(PORT, () => {
  console.log("server listening on", PORT);
});
