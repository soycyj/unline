import http from "http";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// repo 루트의 정적 파일을 그대로 서비스
app.use(express.static(__dirname));

// 루트 접속 시 index.html 반환
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 헬스 체크
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// 룸 상태 메모리
const rooms = new Map();

function getRoom(room) {
  if (!rooms.has(room)) {
    rooms.set(room, {
      sockets: new Set(),
      clientIdBySocket: new Map(),
      roleByClientId: new Map(),
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
      roomState.roleByClientId.set(participants[i], "Visitor");
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
}

function broadcastRoomState(roomState) {
  ensureRoles(roomState);
  const visitors = roomState.sockets.size;

  for (const ws of roomState.sockets) {
    if (ws.readyState !== 1) continue;
    const clientId = roomState.clientIdBySocket.get(ws);
    const role = roomState.roleByClientId.get(clientId) || "Visitor";
    safeSend(ws, { type: "room_state", visitors, role });
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "").trim() || "ROOM";
  const clientId = (url.searchParams.get("clientId") || "").trim() || ("c" + Math.random().toString(16).slice(2, 10));

  const roomState = getRoom(room);

  // 같은 clientId 재접속이면 기존 소켓 회수
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
    roomState.roleByClientId.set(clientId, "Visitor");
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
      for (const s of roomState.sockets) {
        if (s !== ws) safeSend(s, msg);
      }
      return;
    }

    const voiceTypes = new Set([
      "voice_request", "voice_accept", "voice_reject",
      "voice_offer", "voice_answer", "voice_ice", "voice_stop"
    ]);

    if (voiceTypes.has(type)) {
      for (const s of roomState.sockets) {
        if (s !== ws) safeSend(s, msg);
      }
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
server.listen(PORT, () => {
  console.log("Listening on", PORT);
});
