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

/* 길게 그을 때 메시지가 커질 수 있어서 넉넉히 올림 */
const MAX_MSG_BYTES = 256 * 1024;

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

/* 악성 트래픽 방어 기본값 */
const MAX_CONN_PER_IP = 20;
const MAX_CLIENTS_PER_ROOM = 30;

/* 그리기 이벤트는 매우 자주 발생하므로 값 크게 설정 */
const WINDOW_MS = 5000;
const MAX_EVENTS_PER_5S_PER_IP = 2000;

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

/* IP 상태 */
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

/* =========================
   Rooms in memory
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
  ws._joined = false;
  ws._roomCode = "";

  const st = getIpState(ip);
  st.conns += 1;

  if (st.conns > MAX_CONN_PER_IP) {
    st.conns = Math.max(0, st.conns - 1);
    try {
      ws.close(1008, "too many connections");
    } catch {}
    return;
  }

  ws.on("close", () => {
    const s = ipState.get(ws._ip);
    if (s) s.conns = Math.max(0, s.conns - 1);

    if (ws._joined && ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.clients.delete(ws);

        broadcast(ws._roomCode, {
          type: "presence",
          roomCode: ws._roomCode,
          event: "leave",
        });

        broadcastPeople(ws._roomCode);

        if (room.clients.size === 0) {
          rooms.delete(ws._roomCode);
        }
      }
    }
  });

  ws.on("message", async (data) => {
    const ipNow = ws._ip || "unknown";
    const msgBytes = bytesOf(data);

    /* 너무 큰 메시지는 연결을 끊지 말고 무시 */
    if (msgBytes > MAX_MSG_BYTES) {
      console.log("drop message too big", { ip: ipNow, bytes: msgBytes });
      wsSend(ws, { type: "warn", reason: "message too big" });
      return;
    }

    /* 레이트 초과도 연결을 끊지 말고 무시 */
    if (!allowIpEvent(ipNow)) {
      console.log("drop rate limited", { ip: ipNow });
      return;
    }

    const raw = typeof data === "string" ? data : data.toString("utf8");
    const msg = safeJsonParse(raw);
    if (!msg || typeof msg !== "object") return;

    const type = String(msg.type || "");
    const roomCode = normalizeRoom(msg.roomCode || ws._roomCode);

    /* ping pong */
    if (type === "ping") {
      wsSend(ws, { type: "pong" });
      return;
    }

    /* roomCode 검증 */
    if (!ROOM_CODE_RE.test(roomCode)) {
      wsSend(ws, { type: "warn", reason: "invalid room" });
      return;
    }

    console.log("msg", { type, roomCode, bytes: msgBytes, ip: ipNow });

    /* join */
    if (type === "join") {
      if (ws._joined) return;

      const room = getRoom(roomCode);

      if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
        wsSend(ws, { type: "warn", reason: "room full" });
        return;
      }

      ws._joined = true;
      ws._roomCode = roomCode;

      room.clients.add(ws);

      const saved = await redis.get(roomKey(roomCode));

      if (Array.isArray(saved)) {
        room.strokes = saved;
      } else {
        /* 중요
           Redis에 데이터가 없을 때
           방이 비어있던 경우에만 초기화
           이미 누가 그리는 중이면 메모리 유지
        */
        if (room.clients.size === 1) {
          room.strokes = [];
        }
      }

      console.log("join init", {
        roomCode,
        saved: Array.isArray(saved),
        len: room.strokes.length,
      });

      wsSend(ws, { type: "init", roomCode, strokes: room.strokes });

      await touchRoom(roomCode);

      broadcast(roomCode, { type: "presence", roomCode, event: "join" });
      broadcastPeople(roomCode);

      return;
    }

    /* join 필수 */
    if (!ws._joined || !ws._roomCode) {
      wsSend(ws, { type: "warn", reason: "join required" });
      return;
    }

    /* 방 불일치 방지 */
    if (roomCode !== ws._roomCode) {
      wsSend(ws, { type: "warn", reason: "room mismatch" });
      return;
    }

    const room = getRoom(roomCode);

    /* stroke */
    if (type === "stroke") {
      const stroke = msg.stroke;
      if (!stroke || typeof stroke !== "object") return;

      room.strokes.push(stroke);

      if (room.strokes.length > MAX_ROOM_STROKES) {
        room.strokes.splice(0, room.strokes.length - MAX_ROOM_STROKES);
      }

      /* 저장 */
      await redis.set(roomKey(roomCode), room.strokes, { ex: ROOM_TTL_SECONDS });

      broadcast(roomCode, { type: "stroke", roomCode, stroke });
      return;
    }

    /* clear */
    if (type === "clear") {
      console.log("clear", { roomCode, ip: ipNow });

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
