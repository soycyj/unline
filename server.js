// server.js
// Unline drawing + room state + spectators + voice signaling (WebRTC)
// Based on your current ws + Upstash Redis architecture.

import http from "http";
import { WebSocketServer } from "ws";
import { Redis } from "@upstash/redis";

/* Config */
const PORT = Number(process.env.PORT || 8080);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Room persistence
const ROOM_TTL_SECONDS = 60 * 60 * 24;
const MAX_ROOM_STROKES = 5000;

// Limits
const MAX_MSG_BYTES = 256 * 1024;
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

const MAX_CONN_PER_IP = 20;
const MAX_CLIENTS_PER_ROOM = 30;
const MAX_PARTICIPANTS_PER_ROOM = 2;

const WINDOW_MS = 5000;
const MAX_EVENTS_PER_5S_PER_IP = 2000;

// Voice ICE (Metered)
const METERED_BASE_URL = (process.env.METERED_BASE_URL || "").trim();
const METERED_SECRET_KEY = (process.env.METERED_SECRET_KEY || "").trim();

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
  return `room:${roomCode}`;
}

async function touchRoom(roomCode) {
  await redis.expire(roomKey(roomCode), ROOM_TTL_SECONDS);
}

function wsSend(ws, obj) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
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

function httpBaseFromWsUrl(wsUrl) {
  // wss://host -> https://host, ws://host -> http://host
  if (!wsUrl) return "";
  return wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
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
      participants: new Set(),
      spectators: new Set(),
      session: {
        state: "idle", // idle | trial | continued
        trialStartedAt: null,
      },
    });
  }
  return rooms.get(roomCode);
}

function broadcast(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room.clients) wsSend(client, obj);
}

function broadcastToParticipants(roomCode, obj, exceptWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const p of room.participants) {
    if (p !== exceptWs) wsSend(p, obj);
  }
}

function roomCounts(roomCode) {
  const room = rooms.get(roomCode);
  const total = room ? room.clients.size : 0;
  const participants = room ? room.participants.size : 0;
  const spectators = room ? room.spectators.size : 0;
  return { total, participants, spectators };
}

function broadcastPeople(roomCode) {
  const { total, participants, spectators } = roomCounts(roomCode);
  const room = rooms.get(roomCode);
  const sessionState = room?.session?.state || "idle";
  const trialStartedAt = room?.session?.trialStartedAt || null;

  broadcast(roomCode, {
    type: "status",
    roomCode,
    count: total,              // keep backward compatible
    participants,
    spectators,
    sessionState,
    trialStartedAt,
  });
}

/* Persistence format */

function normalizeSavedRoom(saved) {
  // Backward compatible:
  // - saved can be array (strokes only)
  // - or object { v:2, strokes:[], session:{...} }
  if (Array.isArray(saved)) {
    return {
      v: 2,
      strokes: saved,
      session: { state: "idle", trialStartedAt: null },
    };
  }
  if (saved && typeof saved === "object") {
    const strokes = Array.isArray(saved.strokes) ? saved.strokes : [];
    const session = saved.session && typeof saved.session === "object" ? saved.session : {};
    const state = typeof session.state === "string" ? session.state : "idle";
    const trialStartedAt = typeof session.trialStartedAt === "number" ? session.trialStartedAt : null;
    return {
      v: 2,
      strokes,
      session: { state, trialStartedAt },
    };
  }
  return { v: 2, strokes: [], session: { state: "idle", trialStartedAt: null } };
}

async function persistRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = {
    v: 2,
    strokes: room.strokes,
    session: room.session,
  };
  await redis.set(roomKey(roomCode), payload, { ex: ROOM_TTL_SECONDS });
}

/* Voice ICE tokens (single-use) */

const iceTokens = new Map(); // token -> { roomCode, wsId, exp }

function randomToken() {
  // Not crypto-strong, but sufficient for short-lived, single-use tokens.
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function issueIceToken(ws) {
  const token = randomToken();
  iceTokens.set(token, {
    roomCode: ws._roomCode,
    wsId: ws._id,
    exp: now() + 60_000, // 60s
  });
  return token;
}

function consumeIceToken(token) {
  const item = iceTokens.get(token);
  if (!item) return null;
  iceTokens.delete(token);
  if (item.exp < now()) return null;
  return item;
}

/* Server */

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  // ICE config endpoint for WebRTC
  // /ice?token=...
  if (req.url && req.url.startsWith("/ice")) {
    const u = new URL(req.url, "http://localhost");
    const token = (u.searchParams.get("token") || "").trim();
    const consumed = consumeIceToken(token);

    if (!consumed) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid token" }));
      return;
    }

    // If Metered env not set, return public STUN only (works in many networks, not all)
    if (!METERED_BASE_URL || !METERED_SECRET_KEY) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        ],
      }));
      return;
    }

    try {
      // Metered REST API flow:
      // Many Metered setups accept:
      // POST {base}/api/v1/turn/credential?apiKey=SECRET
      // returning { username, credential, ttl, urls:[...] } or { iceServers:[...] }
      //
      // We keep this flexible: if response contains iceServers, use it; otherwise build one.
      const endpoint = `${METERED_BASE_URL.replace(/\/$/, "")}/api/v1/turn/credential?apiKey=${encodeURIComponent(METERED_SECRET_KEY)}`;
      const r = await fetch(endpoint, { method: "POST" });
      if (!r.ok) throw new Error(`metered bad status ${r.status}`);
      const data = await r.json();

      let iceServers = null;

      if (data && Array.isArray(data.iceServers)) {
        iceServers = data.iceServers;
      } else if (data && data.username && data.credential && Array.isArray(data.urls)) {
        iceServers = [{ urls: data.urls, username: data.username, credential: data.credential }];
      } else if (data && data.username && data.credential && data.url) {
        iceServers = [{ urls: [data.url], username: data.username, credential: data.credential }];
      }

      if (!iceServers) {
        // Fallback if Metered response shape differs
        iceServers = [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        ];
      }

      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ iceServers }));
      return;
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        ],
        warn: "metered_error_fallback_stun",
      }));
      return;
    }
  }

  // Default
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const wss = new WebSocketServer({ server });

let wsSeq = 0;

wss.on("connection", (ws, req) => {
  const ip = getIP(req);
  ws._id = `ws_${++wsSeq}`;
  ws._ip = ip;
  ws._joined = false;
  ws._roomCode = "";
  ws._role = "unknown"; // participant | spectator

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

    if (ws._joined && ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.clients.delete(ws);
        room.participants.delete(ws);
        room.spectators.delete(ws);

        broadcastPeople(ws._roomCode);

        if (room.clients.size === 0) {
          // Persist last state and drop memory cache.
          try { await persistRoom(ws._roomCode); } catch {}
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
    const roomCode = normalizeRoom(msg.roomCode || ws._roomCode);

    if (type === "ping") {
      wsSend(ws, { type: "pong" });
      return;
    }

    if (!ROOM_CODE_RE.test(roomCode)) {
      wsSend(ws, { type: "warn", reason: "invalid room" });
      return;
    }

    if (type === "join") {
      if (ws._joined) return;

      const room = getRoom(roomCode);
      const wasActive = room.clients.size > 0;

      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        wsSend(ws, { type: "warn", reason: "room full" });
        return;
      }

      ws._joined = true;
      ws._roomCode = roomCode;
      room.clients.add(ws);

      // Load persisted data
      const savedRaw = await redis.get(roomKey(roomCode));
      const saved = normalizeSavedRoom(savedRaw);

      if (!wasActive) {
        room.strokes = saved.strokes || [];
        room.session = saved.session || { state: "idle", trialStartedAt: null };
      } else {
        // If already active, keep memory but ensure session exists
        if (room.strokes.length === 0 && Array.isArray(saved.strokes)) room.strokes = saved.strokes;
        if (!room.session) room.session = saved.session || { state: "idle", trialStartedAt: null };
      }

      // Role assignment: first 2 = participants, rest = spectators
      if (room.participants.size < MAX_PARTICIPANTS_PER_ROOM) {
        room.participants.add(ws);
        ws._role = "participant";
      } else {
        room.spectators.add(ws);
        ws._role = "spectator";
      }

      wsSend(ws, {
        type: "role",
        roomCode,
        role: ws._role,
        sessionState: room.session.state,
      });

      wsSend(ws, { type: "init", roomCode, strokes: room.strokes, session: room.session });

      await touchRoom(roomCode);
      broadcastPeople(roomCode);
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

    // Spectators restrictions
    const isSpectator = ws._role === "spectator";

    // Session controls
    if (type === "session") {
      if (isSpectator) return;

      const action = String(msg.action || "");
      if (action === "start_trial") {
        if (room.session.state === "trial") return;
        room.session.state = "trial";
        room.session.trialStartedAt = now();
        await persistRoom(roomCode);
        broadcast(roomCode, { type: "session", roomCode, session: room.session });
        broadcastPeople(roomCode);
        return;
      }
      if (action === "continue") {
        room.session.state = "continued";
        await persistRoom(roomCode);
        broadcast(roomCode, { type: "session", roomCode, session: room.session });
        broadcastPeople(roomCode);
        return;
      }
      if (action === "end") {
        room.session.state = "idle";
        room.session.trialStartedAt = null;
        await persistRoom(roomCode);
        broadcast(roomCode, { type: "session", roomCode, session: room.session });
        broadcastPeople(roomCode);
        return;
      }
      return;
    }

    // ICE token request (participants only)
    if (type === "ice_token") {
      if (isSpectator) return;
      const token = issueIceToken(ws);
      wsSend(ws, { type: "ice_token", token, httpBase: httpBaseFromWsUrl(msg.wsUrl || "") });
      return;
    }

    // Drawing
    if (type === "stroke") {
      if (isSpectator) return;
      const stroke = msg.stroke;
      if (!stroke || typeof stroke !== "object") return;

      room.strokes.push(stroke);
      if (room.strokes.length > MAX_ROOM_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_ROOM_STROKES);
      }

      await persistRoom(roomCode);
      broadcast(roomCode, { type: "stroke", roomCode, stroke });
      return;
    }

    if (type === "clear") {
      if (isSpectator) return;
      room.strokes = [];
      await persistRoom(roomCode);
      broadcast(roomCode, { type: "clear", roomCode });
      return;
    }

    // Voice signaling: only between the two participants
    if (type === "voice") {
      if (isSpectator) return;

      // forward to the other participant
      const payload = {
        type: "voice",
        roomCode,
        from: ws._id,
        action: String(msg.action || ""),
        data: msg.data || null,
      };
      broadcastToParticipants(roomCode, payload, ws);
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`WS server listening on port ${PORT}`);
});
