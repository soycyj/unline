import http from "http";
import { WebSocketServer } from "ws";
import { Redis } from "@upstash/redis";

/* =========================
   Config
========================= */

const PORT = Number(process.env.PORT || 8080);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ROOM_TTL_SECONDS = 60 * 60 * 24;

const MAX_ROOM_STROKES = 5000;
const MAX_MSG_BYTES = 64 * 1024;

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

const MAX_CONN_PER_IP = 20;
const MAX_CLIENTS_PER_ROOM = 30;

const WINDOW_MS = 5000;
const MAX_EVENTS_PER_5S_PER_IP = 120;

/* =========================
   Helpers
========================= */

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

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

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

function wsSend(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function bytesOf(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  return Buffer.byteLength(String(data));
}

/* =========================
   In memory rooms
========================= */

const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { strokes: [], clients: new Set() });
  }
  return rooms.get(roomCode);
}

function broadcast(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room.clients) wsSend(client, obj);
}

function broadcastPeople(roomCode) {
  const room = rooms.get(roomCode);
  const count = room ? room.clients.size : 0;
  broadcast(roomCode, { type: "status", roomCode, count });
}

/* =========================
   Server
========================= */

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("ok");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = getIP(req);
  ws._ip = ip;

  const st = getIpState(ip);
  st.conns += 1;

  if (st.conns > MAX_CONN_PER_IP) {
    st.conns = Math.max(0, st.conns - 1);
    try {
      ws.close(1008, "too many connections");
    } catch {}
    return;
  }

  ws._joined = false;
  ws._roomCode = "";

  ws.on("close", () => {
    const s = ipState.get(ws._ip);
    if (s) s.conns = Math.max(0, s.conns - 1);

    if (ws._joined && ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.clients.delete(ws);
        broadcast(ws._roomCode, { type: "presence", roomCode: ws._roomCode, event: "leave" });
        broadcastPeople(ws._roomCode);

        if (room.clients.size === 0) {
          rooms.delete(ws._roomCode);
        }
      }
    }
  });

  ws.on("message", async (data) => {
    const ipNow = ws._ip || "unknown";

    if (bytesOf(data) > MAX_MSG_BYTES) {
      try {
        ws.close(1009, "message too big");
      } catch {}
      return;
    }

    if (!allowIpEvent(ipNow)) {
      try {
        ws.close(1008, "rate limited");
      } catch {}
      return;
    }

    const raw = typeof data === "string" ? data : data.toString("utf8");
    const msg = safeJsonParse(raw);
    if (!msg || typeof msg !== "object") return;

    const type = String(msg.type || "");
    const roomCode = normalizeRoom(msg.roomCode || ws._roomCode);

    if (type !== "ping") {
      if (!ROOM_CODE_RE.test(roomCode)) {
        try {
          ws.close(1008, "invalid room");
        } catch {}
        return;
      }
    }

    if (type === "ping") {
      wsSend(ws, { type: "pong" });
      return;
    }

    if (type === "join") {
      if (ws._joined) return;

      const room = getRoom(roomCode);

      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        try {
          ws.close(1008, "room full");
        } catch {}
        return;
      }

      ws._joined = true;
      ws._roomCode = roomCode;

      room.clients.add(ws);

      const saved = await redis.get(roomKey(roomCode));
      if (Array.isArray(saved)) {
        room.strokes = saved;
      } else {
        room.strokes = [];
      }

      wsSend(ws, { type: "init", roomCode, strokes: room.strokes });

      await touchRoom(roomCode);

      broadcast(roomCode, { type: "presence", roomCode, event: "join" });
      broadcastPeople(roomCode);
      return;
    }

    if (!ws._joined || !ws._roomCode) {
      try {
        ws.close(1008, "join required");
      } catch {}
      return;
    }

    if (roomCode !== ws._roomCode) {
      try {
        ws.close(1008, "room mismatch");
      } catch {}
      return;
    }

    const room = getRoom(roomCode);

    if (type === "stroke") {
      const stroke = msg.stroke;
      if (!stroke || typeof stroke !== "object") return;

      room.strokes.push(stroke);

      if (room.strokes.length > MAX_ROOM_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_ROOM_STROKES);
      }

      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });

      broadcast(roomCode, { type: "stroke", roomCode, stroke });
      return;
    }

    if (type === "clear") {
      room.strokes = [];
      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });

      broadcast(roomCode, { type: "clear", roomCode });
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`WS server listening on port ${PORT}`);
});
