import http from "http";
import { WebSocketServer } from "ws";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.REDIS_URL,
});

const ROOM_TTL_SECONDS = 60 * 60 * 24;

function roomKey(roomCode) {
  return `room:${roomCode}`;
}

async function touchRoom(roomCode) {
  await redis.expire(roomKey(roomCode), ROOM_TTL_SECONDS);
}

const PORT = Number(process.env.PORT || 8080);

const rooms = new Map();

const MAX_ROOM_STROKES = 5000;
const MAX_MSG_BYTES = 64 * 1024;
const MAX_EVENTS_PER_5S = 800;

function now() {
  return Date.now();
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function normalizeRoom(code) {
  return String(code || "").trim().toUpperCase();
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { strokes: [], clients: new Set() });
  }
  return rooms.get(roomCode);
}

function wsSend(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(roomCode, obj) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const msg = JSON.stringify(obj);
  for (const client of room.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastStatus(roomCode) {
  const room = rooms.get(roomCode);
  const count = room ? room.clients.size : 0;
  broadcast(roomCode, { type: "status", roomCode, count });
}

function broadcastPresence(roomCode, event) {
  broadcast(roomCode, { type: "presence", roomCode, event, t: now() });
}

function isValidPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function sanitizeStroke(stroke) {
  if (!stroke || typeof stroke !== "object") return null;

  if (stroke.clear === true) {
    return { clear: true, t: Number(stroke.t || now()) };
  }

  const a = stroke.a;
  const b = stroke.b;
  const mode = stroke.mode === "erase" ? "erase" : "pen";
  const color = typeof stroke.color === "string" ? stroke.color.slice(0, 32) : "#111111";
  const size = Number(stroke.size);

  if (!isValidPoint(a) || !isValidPoint(b)) return null;
  if (!Number.isFinite(size) || size < 1 || size > 60) return null;

  return {
    a: { x: a.x, y: a.y },
    b: { x: b.x, y: b.y },
    mode,
    color,
    size,
    t: Number(stroke.t || now())
  };
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("unline ws server");
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

function initLimiter(ws) {
  ws._lim = { windowStart: now(), count: 0 };
}

function allowEvent(ws) {
  const t = now();
  if (!ws._lim) initLimiter(ws);
  if (t - ws._lim.windowStart > 5000) {
    ws._lim.windowStart = t;
    ws._lim.count = 0;
  }
  ws._lim.count += 1;
  return ws._lim.count <= MAX_EVENTS_PER_5S;
}

wss.on("connection", (ws) => {
  initLimiter(ws);
  ws._roomCode = "";
  ws._joined = false;

  ws.on("message", async (data) => {
    if (!allowEvent(ws)) {
      try { ws.close(1008, "rate limited"); } catch {}
      return;
    }

    const text = typeof data === "string" ? data : data.toString("utf8");
    const msg = safeJsonParse(text);
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "join") {
      const roomCode = normalizeRoom(msg.roomCode);
      if (!roomCode) return;

      if (ws._joined && ws._roomCode) {
        const prev = rooms.get(ws._roomCode);
        if (prev) {
          prev.clients.delete(ws);
          broadcastPresence(ws._roomCode, "leave");
          broadcastStatus(ws._roomCode);
        }
      }

      ws._roomCode = roomCode;
      ws._joined = true;

      const room = getRoom(roomCode);
      room.clients.add(ws);

      const saved = await redis.get(roomKey(roomCode));
        if (Array.isArray(saved)) {
         room.strokes = saved;
        }

      wsSend(ws, { type: "init", roomCode, strokes: room.strokes });

        await touchRoom(roomCode);

      broadcastPresence(roomCode, "join");
      broadcastStatus(roomCode);
      return;
    }

    if (!ws._joined || !ws._roomCode) return;

    if (msg.type === "stroke" && msg.stroke) {
      const roomCode = ws._roomCode;
      const room = getRoom(roomCode);

      const stroke = sanitizeStroke(msg.stroke);
      if (!stroke) return;

      room.strokes.push(stroke);

      if (room.strokes.length > MAX_ROOM_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_ROOM_STROKES);
      }

        await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });

      broadcast(roomCode, { type: "stroke", roomCode, stroke });
      return;
    }
  });

  ws.on("close", () => {
    if (ws._joined && ws._roomCode) {
      const roomCode = ws._roomCode;
      const room = rooms.get(roomCode);
      if (room) {
        room.clients.delete(ws);
        broadcastPresence(roomCode, "leave");
        broadcastStatus(roomCode);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("WS server listening on port", PORT);
});
