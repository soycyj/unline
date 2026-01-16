import http from "http";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const rooms = new Map();
// rooms.get(room) shape
// {
//   sockets: Set<WebSocket>
//   clientIdBySocket: Map<WebSocket, string>
//   roleByClientId: Map<string, "Participant" | "Visitor">
// }

function getRoom(room){
  if(!rooms.has(room)){
    rooms.set(room, {
      sockets: new Set(),
      clientIdBySocket: new Map(),
      roleByClientId: new Map()
    });
  }
  return rooms.get(room);
}

function countVisitors(roomState){
  return roomState.sockets.size;
}

function ensureRoles(roomState){
  // Participant 최대 2명 유지
  const entries = Array.from(roomState.roleByClientId.entries());

  const participants = entries.filter(([, r]) => r === "Participant").map(([id]) => id);
  if(participants.length > 2){
    // 초과분 Visitor로 내림
    for(let i = 2; i < participants.length; i++){
      roomState.roleByClientId.set(participants[i], "Visitor");
    }
  }

  const currentParticipants = Array.from(roomState.roleByClientId.values()).filter(r => r === "Participant").length;
  if(currentParticipants < 2){
    // 빈 자리를 Visitor에서 승격
    const ids = Array.from(roomState.roleByClientId.keys());
    for(const id of ids){
      if(roomState.roleByClientId.get(id) !== "Participant"){
        roomState.roleByClientId.set(id, "Participant");
        const now = Array.from(roomState.roleByClientId.values()).filter(r => r === "Participant").length;
        if(now >= 2) break;
      }
    }
  }
}

function broadcastRoomState(roomState){
  ensureRoles(roomState);
  const visitors = countVisitors(roomState);

  for(const ws of roomState.sockets){
    if(ws.readyState !== 1) continue;
    const clientId = roomState.clientIdBySocket.get(ws);
    const role = roomState.roleByClientId.get(clientId) || "Visitor";
    ws.send(JSON.stringify({ type: "room_state", visitors, role }));
  }
}

function safeSend(ws, obj){
  try{
    if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }catch(e){}
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "").trim() || "ROOM";
  const clientId = (url.searchParams.get("clientId") || "").trim() || ("c" + Math.random().toString(16).slice(2,10));

  const roomState = getRoom(room);

  // 같은 clientId 재접속이면 기존 소켓들 정리
  for(const [sock, id] of roomState.clientIdBySocket.entries()){
    if(id === clientId && sock !== ws){
      try{ sock.close(4001, "reclaimed"); }catch(e){}
      roomState.sockets.delete(sock);
      roomState.clientIdBySocket.delete(sock);
    }
  }

  roomState.sockets.add(ws);
  roomState.clientIdBySocket.set(ws, clientId);

  if(!roomState.roleByClientId.has(clientId)){
    roomState.roleByClientId.set(clientId, "Visitor");
  }

  broadcastRoomState(roomState);

  ws.on("message", (raw) => {
    let msg;
    try{ msg = JSON.parse(raw.toString("utf8")); }catch(e){ return; }

    const type = msg.type || "";

    if(type === "hello"){
      broadcastRoomState(roomState);
      return;
    }

    if(type === "draw" || type === "clear"){
      for(const s of roomState.sockets){
        if(s !== ws) safeSend(s, msg);
      }
      return;
    }

    const voiceTypes = new Set([
      "voice_request","voice_accept","voice_reject","voice_offer","voice_answer","voice_ice","voice_stop"
    ]);

    if(voiceTypes.has(type)){
      for(const s of roomState.sockets){
        if(s !== ws) safeSend(s, msg);
      }
      return;
    }
  });

  ws.on("close", () => {
    roomState.sockets.delete(ws);
    roomState.clientIdBySocket.delete(ws);

    // 남아있는 소켓이 없는 clientId는 roleByClientId에서도 제거
    const stillAliveIds = new Set(Array.from(roomState.clientIdBySocket.values()));
    for(const id of Array.from(roomState.roleByClientId.keys())){
      if(!stillAliveIds.has(id)) roomState.roleByClientId.delete(id);
    }

    if(roomState.sockets.size === 0){
      rooms.delete(room);
      return;
    }

    broadcastRoomState(roomState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Listening on", PORT));
