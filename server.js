// server.js
// Unline: WebSocket drawing sync + spectator mode + (optional) 1:1 voice signaling.
// - Room state persists across restarts via Upstash Redis (strokes + minimal meta).
// - First two connections per room are participants; additional are spectators.
// - Spectators can watch but cannot draw or use voice.
// - Voice starts only when a participant clicks "Start voice".

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { Redis } from "@upstash/redis";

/* Config */

const PORT = Number(process.env.PORT || 8080);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ROOM_TTL_SECONDS = 60 * 60 * 24;
const MAX_ROOM_STROKES = 8000;
const MAX_MSG_BYTES = 256 * 1024;

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

const MAX_CONN_PER_IP = 20;
const MAX_CLIENTS_PER_ROOM = 30;

const WINDOW_MS = 5000;
const MAX_EVENTS_PER_5S_PER_IP = 2000;

// Metered TURN (set via Render env vars)
// NOTE: These values are returned to participants ONLY after they click "Start voice".
const TURN_HOST = (process.env.METERED_TURN_HOST || "").trim();
const TURN_USERNAME = (process.env.METERED_TURN_USERNAME || "").trim();
const TURN_CREDENTIAL = (process.env.METERED_TURN_CREDENTIAL || "").trim();
const STUN_HOST = (process.env.METERED_STUN_HOST || "stun.relay.metered.ca").trim();

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

function roomMetaKey(roomCode) {
  return `roommeta:${roomCode}`;
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

function getIceServers() {
  // If TURN is not configured, return an empty list. The client will still try P2P.
  if (!TURN_HOST || !TURN_USERNAME || !TURN_CREDENTIAL) return [];

  // Conservative, network-friendly defaults.
  return [
    { urls: `stun:${STUN_HOST}:80` },
    {
      urls: `turn:${TURN_HOST}:80`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    },
    {
      urls: `turn:${TURN_HOST}:80?transport=tcp`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    },
    {
      urls: `turn:${TURN_HOST}:443`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    },
    {
      urls: `turns:${TURN_HOST}:443?transport=tcp`,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    },
  ];
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

// roomCode -> { strokes: [], clients:Set(ws), participants:[ws|null, ws|null] }
const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      strokes: [],
      clients: new Set(),
      participants: [null, null],
    });
  }
  return rooms.get(roomCode);
}

function otherParticipant(room, ws) {
  if (!room) return null;
  for (const p of room.participants) {
    if (p && p !== ws) return p;
  }
  return null;
}

function broadcast(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room.clients) wsSend(client, obj);
}

function broadcastPeople(roomCode) {
  const room = rooms.get(roomCode);
  const count = room ? room.clients.size : 0;
  const participants = room ? room.participants.filter(Boolean).length : 0;
  broadcast(roomCode, { type: "status", roomCode, count, participants });
}

async function saveMeta(roomCode, room) {
  const meta = {
    roomCode,
    updatedAt: now(),
    // "active" means 2 participants present
    status: room.participants.filter(Boolean).length === 2 ? "active" : "quiet",
    participants: room.participants.filter(Boolean).length,
    clients: room.clients.size,
  };
  await redis.set(roomMetaKey(roomCode), meta, { ex: ROOM_TTL_SECONDS });
  await touchRoom(roomCode);
}

/* Static file server */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function send(res, code, type, body) {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

function serveFile(res, filePath, type) {
  try {
    const data = fs.readFileSync(filePath);
    send(res, 200, type, data);
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "not found");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/health") {
    send(res, 200, "text/plain; charset=utf-8", "ok");
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    serveFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (pathname === "/canvas.html") {
    serveFile(res, path.join(__dirname, "canvas.html"), "text/html; charset=utf-8");
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "not found");
});

/* WebSocket */

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = getIP(req);
  ws._ip = ip;
  ws._joined = false;
  ws._roomCode = "";
  ws._role = "spectator"; // participant | spectator
  ws._slot = -1; // 0 or 1 for participants

  const st = getIpState(ip);
  st.conns += 1;

  if (st.conns > MAX_CONN_PER_IP) {
    st.conns = Math.max(0, st.conns - 1);
    try {
      ws.close(1008, "too many connections");
    } catch {}
    return;
  }

  ws.on("close", async () => {
    const s = ipState.get(ws._ip);
    if (s) s.conns = Math.max(0, s.conns - 1);

    if (ws._joined && ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.clients.delete(ws);
        if (ws._role === "participant" && ws._slot >= 0) {
          if (room.participants[ws._slot] === ws) room.participants[ws._slot] = null;
        }

        broadcastPeople(ws._roomCode);
        await saveMeta(ws._roomCode, room);

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

      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        wsSend(ws, { type: "warn", reason: "room full" });
        return;
      }

      // Assign role: first 2 are participants, rest spectators
      let role = "spectator";
      let slot = -1;
      for (let i = 0; i < 2; i += 1) {
        if (!room.participants[i]) {
          room.participants[i] = ws;
          role = "participant";
          slot = i;
          break;
        }
      }

      ws._joined = true;
      ws._roomCode = roomCode;
      ws._role = role;
      ws._slot = slot;
      room.clients.add(ws);

      // Load strokes from Redis only once per cold room
      const saved = await redis.get(roomKey(roomCode));
      if (room.strokes.length === 0 && Array.isArray(saved)) {
        room.strokes = saved;
      }

      const meta = await redis.get(roomMetaKey(roomCode));
      const status = meta && typeof meta === "object" && meta.status ? meta.status : "quiet";

      wsSend(ws, {
        type: "init",
        roomCode,
        role,
        slot,
        status,
        strokes: room.strokes,
      });

      await saveMeta(roomCode, room);
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

    // Drawing permissions
    if (type === "stroke" || type === "clear") {
      if (ws._role !== "participant") {
        wsSend(ws, { type: "warn", reason: "spectators cannot draw" });
        return;
      }
    }

    if (type === "stroke") {
      const stroke = msg.stroke;
      if (!stroke || typeof stroke !== "object") return;

      room.strokes.push(stroke);
      if (room.strokes.length > MAX_ROOM_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_ROOM_STROKES);
      }

      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });
      await saveMeta(roomCode, room);

      broadcast(roomCode, { type: "stroke", roomCode, stroke });
      return;
    }

    if (type === "clear") {
      room.strokes = [];
      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });
      await saveMeta(roomCode, room);

      broadcast(roomCode, { type: "clear", roomCode });
      return;
    }

    // Voice signaling (participants only)
    const voiceTypes = new Set([
      "voice_request",
      "voice_accept",
      "voice_reject",
      "voice_offer",
      "voice_answer",
      "voice_candidate",
      "voice_end",
      "get_ice",
    ]);

    if (voiceTypes.has(type)) {
      if (ws._role !== "participant") {
        wsSend(ws, { type: "warn", reason: "spectators cannot use voice" });
        return;
      }

      if (type === "get_ice") {
        wsSend(ws, { type: "ice", roomCode, iceServers: getIceServers() });
        return;
      }

      const peer = otherParticipant(room, ws);
      if (!peer) {
        wsSend(ws, { type: "warn", reason: "no peer" });
        return;
      }

      // Pass-through signaling payload (offer/answer/candidate)
      if (type === "voice_offer" || type === "voice_answer" || type === "voice_candidate") {
        wsSend(peer, {
          type,
          roomCode,
          fromSlot: ws._slot,
          payload: msg.payload || null,
        });
        return;
      }

      // Simple control messages
      wsSend(peer, { type, roomCode, fromSlot: ws._slot });
      return;
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Unline server listening on :${PORT}`);
});
