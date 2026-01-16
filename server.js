import http from "http";
import { WebSocketServer } from "ws";
import { Redis } from "@upstash/redis";

/* Config */

const PORT = Number(process.env.PORT || 8080);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Room data retention
const ROOM_TTL_SECONDS = 60 * 60 * 24;

// Drawing strokes
const MAX_ROOM_STROKES = 5000;

// Safety
const MAX_MSG_BYTES = 256 * 1024;
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

const MAX_CONN_PER_IP = 20;
const MAX_CLIENTS_PER_ROOM = 60; // participants(2) + spectators

const WINDOW_MS = 5000;
const MAX_EVENTS_PER_5S_PER_IP = 2000;

// Session
const TRIAL_SECONDS = 10 * 60;

/* Helpers */

function now() {
  return Date.now();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function normalizeRoom(code) {
  return String(code || "").trim().toUpperCase();
}

function roomKey(roomCode) {
  return `room:${roomCode}:strokes`;
}

function roomMetaKey(roomCode) {
  return `room:${roomCode}:meta`;
}

async function touchRoom(roomCode) {
  await redis.expire(roomKey(roomCode), ROOM_TTL_SECONDS);
  await redis.expire(roomMetaKey(roomCode), ROOM_TTL_SECONDS);
}

function wsSend(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function bytesOf(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  return Buffer.byteLength(String(data));
}

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function computeTrialEndsAt(meta) {
  if (!meta || meta.sessionState !== "trial" || !meta.trialStartedAt) return 0;
  return meta.trialStartedAt + TRIAL_SECONDS * 1000;
}

function computeSessionState(meta) {
  const state = String(meta?.sessionState || "idle");
  if (state === "trial") {
    const endsAt = computeTrialEndsAt(meta);
    if (endsAt && now() >= endsAt) return "ended";
    return "trial";
  }
  if (state === "continued") return "continued";
  if (state === "ended") return "ended";
  return "idle";
}

/* IP state */

const ipState = new Map();

function getIpState(ip) {
  let s = ipState.get(ip);
  if (!s) {
    s = { count: 0, windowStart: now(), conns: 0 };
    ipState.set(ip, s);
  }
  return s;
}

function allowIpEvent(ip) {
  const t = now();
  const s = getIpState(ip);

  if (t - s.windowStart > WINDOW_MS) {
    s.windowStart = t;
    s.count = 0;
  }

  s.count += 1;
  return s.count <= MAX_EVENTS_PER_5S_PER_IP;
}

/* Rooms in memory */

const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      strokes: [],
      clients: new Set(),
      participants: new Set(), // ws
      spectators: new Set(), // ws
      meta: { sessionState: "idle", trialStartedAt: 0, lastRoomState: "quiet", lastActiveAt: now() },
    });
  }
  return rooms.get(roomCode);
}

function promoteSpectatorIfPossible(room) {
  // Keep room strictly 2 participants.
  // If a participant slot opens, automatically promote the oldest spectator.
  while (room && room.participants.size < 2 && room.spectators.size > 0) {
    const next = room.spectators.values().next().value;
    if (!next) break;
    room.spectators.delete(next);
    room.participants.add(next);
    next._role = "participant";
  }
}

function getCounts(room) {
  return {
    total: room.clients.size,
    participants: room.participants.size,
    spectators: room.spectators.size,
  };
}

async function loadRoomMeta(roomCode) {
  const meta = await redis.get(roomMetaKey(roomCode));
  if (meta && typeof meta === "object") return meta;
  return { sessionState: "idle", trialStartedAt: 0, lastRoomState: "quiet", lastActiveAt: now() };
}

async function saveRoomMeta(roomCode, meta) {
  await redis.set(roomMetaKey(roomCode), meta, { ex: ROOM_TTL_SECONDS });
  await touchRoom(roomCode);
}

function broadcast(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room.clients) wsSend(client, obj);
}

function broadcastStatus(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const counts = getCounts(room);
  const meta = room.meta || {};
  const sessionState = computeSessionState(meta);
  const trialEndsAt = sessionState === "trial" ? computeTrialEndsAt(meta) : 0;

  for (const client of room.clients) {
    const role = room.participants.has(client) ? "participant" : "spectator";
    wsSend(client, {
      type: "status",
      roomCode,
      count: counts.total,
      participants: counts.participants,
      spectators: counts.spectators,
      role,
      sessionState,
      trialEndsAt,
    });
  }
}

async function ensureTrialStarted(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const meta = room.meta || {};
  const state = computeSessionState(meta);

  // Only start trial automatically when there are exactly 2 participants and session is idle
  if (room.participants.size >= 2 && state === "idle") {
    meta.sessionState = "trial";
    meta.trialStartedAt = now();
    meta.lastActiveAt = now();
    meta.lastRoomState = "active";
    room.meta = meta;
    await saveRoomMeta(roomCode, meta);

    broadcast(roomCode, {
      type: "session",
      roomCode,
      sessionState: "trial",
      trialEndsAt: computeTrialEndsAt(meta),
    });
  }
}

async function checkTrialExpiry(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const meta = room.meta || {};
  const state = computeSessionState(meta);
  if (state !== "ended") return;

  // Persist ended state once
  if (meta.sessionState === "trial") {
    meta.sessionState = "ended";
    meta.lastActiveAt = now();
    room.meta = meta;
    await saveRoomMeta(roomCode, meta);
    broadcast(roomCode, { type: "session", roomCode, sessionState: "ended" });
  }
}

/* Matchmaking (simple MVP in memory) */

const coachWaitQueues = new Map(); // key -> Set<ws>

function matchKey(lang, goal) {
  return `${String(lang || "EN").toUpperCase()}|${String(goal || "CONV").toUpperCase()}`;
}

function addCoachToQueue(ws, key) {
  if (!coachWaitQueues.has(key)) coachWaitQueues.set(key, new Set());
  coachWaitQueues.get(key).add(ws);
  ws._matchKey = key;
  ws._isCoachWaiting = true;
}

function removeCoachFromQueue(ws) {
  const key = ws._matchKey;
  if (!key) return;
  const q = coachWaitQueues.get(key);
  if (q) q.delete(ws);
  ws._matchKey = "";
  ws._isCoachWaiting = false;
}

/* Server */

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("ok");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = getIP(req);
  ws._ip = ip;
  ws._joined = false;
  ws._roomCode = "";
  ws._role = ""; // participant | spectator
  ws._matchKey = "";
  ws._isCoachWaiting = false;

  const st = getIpState(ip);
  st.conns += 1;

  if (st.conns > MAX_CONN_PER_IP) {
    st.conns = Math.max(0, st.conns - 1);
    try { ws.close(1008, "too many connections"); } catch {}
    return;
  }

  ws.on("close", async () => {
    const s = ipState.get(ws._ip);
    if (s) s.conns = Math.max(0, s.conns - 1);

    removeCoachFromQueue(ws);

    if (ws._joined && ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.clients.delete(ws);
        room.participants.delete(ws);
        room.spectators.delete(ws);

        // If a participant slot opened, promote the oldest spectator automatically.
        promoteSpectatorIfPossible(room);

        // Update meta and persist lastRoomState
        const meta = room.meta || (await loadRoomMeta(ws._roomCode));
        meta.lastActiveAt = now();
        meta.lastRoomState = room.participants.size >= 2 ? "active" : "quiet";
        room.meta = meta;
        await saveRoomMeta(ws._roomCode, meta);

        broadcastStatus(ws._roomCode);

        if (room.clients.size === 0) {
          rooms.delete(ws._roomCode);
        }
      }
    }
  });

  ws.on("message", async (data) => {
    const ipNow = ws._ip || "unknown";
    const msgBytes = bytesOf(data);

    if (msgBytes > MAX_MSG_BYTES) {
      wsSend(ws, { type: "warn", reason: "message too big" });
      return;
    }

    if (!allowIpEvent(ipNow)) return;

    const raw = typeof data === "string" ? data : data.toString("utf8");
    const msg = safeJsonParse(raw);
    if (!msg || typeof msg !== "object") return;

    const type = String(msg.type || "");

    // Heartbeat
    if (type === "ping") {
      wsSend(ws, { type: "pong" });
      return;
    }

    // Matchmaking messages live on index.html (no room join required)
    if (type === "match_request") {
      const role = String(msg.role || "");
      const lang = String(msg.lang || "EN").toUpperCase();
      const goal = String(msg.goal || "CONV").toUpperCase();
      const key = matchKey(lang, goal);

      if (role === "coach") {
        removeCoachFromQueue(ws);
        addCoachToQueue(ws, key);
        wsSend(ws, { type: "waiting", role: "coach" });
        return;
      }

      if (role === "student") {
        const q = coachWaitQueues.get(key);
        const coach = q ? Array.from(q).find(c => c.readyState === 1) : null;
        if (!coach) {
          wsSend(ws, { type: "waiting", role: "student" });
          return;
        }

        // Consume coach
        q.delete(coach);
        coach._isCoachWaiting = false;

        const roomCode = randomRoomCode();
        const meta = { sessionState: "idle", trialStartedAt: 0, lastRoomState: "quiet", lastActiveAt: now() };
        await saveRoomMeta(roomCode, meta);
        await redis.set(roomKey(roomCode), [], { ex: ROOM_TTL_SECONDS });

        wsSend(coach, { type: "matched", roomCode });
        wsSend(ws, { type: "matched", roomCode });
        return;
      }

      wsSend(ws, { type: "warn", reason: "invalid match role" });
      return;
    }

    // Room based messages
    const roomCode = normalizeRoom(msg.roomCode || ws._roomCode);

    if (!ROOM_CODE_RE.test(roomCode)) {
      wsSend(ws, { type: "warn", reason: "invalid room" });
      return;
    }

    if (type === "join") {
      if (ws._joined) return;

      const room = getRoom(roomCode);

      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        wsSend(ws, { type: "warn", reason: "room full" });
        return;
      }

      ws._joined = true;
      ws._roomCode = roomCode;

      // Assign role: first two are participants, others spectators
      if (room.participants.size < 2) {
        ws._role = "participant";
        room.participants.add(ws);
      } else {
        ws._role = "spectator";
        room.spectators.add(ws);
      }

      room.clients.add(ws);

      // Load persisted strokes and meta
      const savedStrokes = await redis.get(roomKey(roomCode));
      if (Array.isArray(savedStrokes)) room.strokes = savedStrokes;

      room.meta = await loadRoomMeta(roomCode);

      // Session state reconciliation
      const sessionState = computeSessionState(room.meta);
      const trialEndsAt = sessionState === "trial" ? computeTrialEndsAt(room.meta) : 0;

      // Send init
      wsSend(ws, {
        type: "init",
        roomCode,
        strokes: room.strokes,
        count: room.clients.size,
        role: ws._role,
        sessionState,
        trialEndsAt,
      });

      await touchRoom(roomCode);

      // Update meta lastRoomState
      room.meta.lastActiveAt = now();
      room.meta.lastRoomState = room.participants.size >= 2 ? "active" : "quiet";
      await saveRoomMeta(roomCode, room.meta);

      broadcastStatus(roomCode);

      // Auto start trial if two participants are present and session is idle
      await ensureTrialStarted(roomCode);

      // If trial already expired, convert to ended and inform clients
      await checkTrialExpiry(roomCode);
      return;
    }

    if (!ws._joined || !ws._roomCode) {
      wsSend(ws, { type: "warn", reason: "join required" });
      return;
    }

    if (roomCode !== ws._roomCode) {
      wsSend(ws, { type: "warn", reason: "room mismatch" });
      return;
    }

    const room = getRoom(roomCode);

    // Keep session expiry updated on any message
    await checkTrialExpiry(roomCode);

    // Spectator restrictions
    const isSpectator = room.spectators.has(ws);

    if (type === "stroke") {
      if (isSpectator) return;

      const stroke = msg.stroke;
      if (!stroke || typeof stroke !== "object") return;

      room.strokes.push(stroke);

      if (room.strokes.length > MAX_ROOM_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_ROOM_STROKES);
      }

      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });
      await touchRoom(roomCode);

      room.meta.lastActiveAt = now();
      room.meta.lastRoomState = room.participants.size >= 2 ? "active" : "quiet";
      await saveRoomMeta(roomCode, room.meta);

      broadcast(roomCode, { type: "stroke", roomCode, stroke });
      return;
    }

    if (type === "clear") {
      if (isSpectator) return;

      room.strokes = [];
      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });
      await touchRoom(roomCode);

      room.meta.lastActiveAt = now();
      await saveRoomMeta(roomCode, room.meta);

      broadcast(roomCode, { type: "clear", roomCode });
      return;
    }

    if (type === "continue") {
      if (isSpectator) return;

      const meta = room.meta || (await loadRoomMeta(roomCode));
      meta.sessionState = "continued";
      meta.lastActiveAt = now();
      meta.lastRoomState = room.participants.size >= 2 ? "active" : "quiet";
      room.meta = meta;
      await saveRoomMeta(roomCode, meta);

      broadcast(roomCode, { type: "session", roomCode, sessionState: "continued" });
      broadcastStatus(roomCode);
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`WS server listening on port ${PORT}`);
});
