import http from "http";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// In memory room state
// rooms[room] = {
//   clientsById: Map(clientId -> { ws, role }),
//   sockets: Set(ws)
// }
const rooms = new Map();

function getRoom(room){
  if(!rooms.has(room)){
    rooms.set(room, {
      clientsById: new Map(),
      sockets: new Set()
    });
  }
  return rooms.get(room);
}

function computeRole(roomState, clientId){
  // Keep existing role if known
  const existing = roomState.clientsById.get(clientId);
  if(existing && existing.role) return existing.role;

  // Determine based on current participant count excluding this clientId
  let participants = 0;
  for(const [id, info] of roomState.clientsById.entries()){
    if(id === clientId) continue;
    if(info && info.role === "Participant") participants++;
  }
  return participants < 2 ? "Participant" : "Visitor";
}

function broadcastRoomState(roomState){
  const visitors = roomState.sockets.size;

  // Send individualized role plus global visitors
  for(const [clientId, info] of roomState.clientsById.entries()){
    if(!info || !info.ws) continue;
    if(info.ws.readyState !== 1) continue;
    const payload = {
      type: "room_state",
      visitors,
      role: info.role
    };
    info.ws.send(JSON.stringify(payload));
  }
}

function safeSend(ws, obj){
  try{
    if(ws && ws.readyState === 1){
      ws.send(JSON.stringify(obj));
    }
  }catch(e){}
}

function reclaimClient(roomState, clientId, newWs){
  const existing = roomState.clientsById.get(clientId);
  if(existing && existing.ws && existing.ws !== newWs){
    // close old socket
    try{
      safeSend(existing.ws, { type:"reclaimed" });
      existing.ws.close(4001, "reclaimed");
    }catch(e){}
    try{
      roomState.sockets.delete(existing.ws);
    }catch(e){}
  }
}

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = (url.searchParams.get("room") || "").trim() || "ROOM";
  const clientId = (url.searchParams.get("clientId") || "").trim() || ("c" + Math.random().toString(16).slice(2,10));

  const roomState = getRoom(room);

  // Reclaim logic for same clientId
  reclaimClient(roomState, clientId, ws);

  // Determine role
  const role = computeRole(roomState, clientId);

  // Register
  roomState.sockets.add(ws);
  roomState.clientsById.set(clientId, { ws, role });

  console.log("WS connected", { room, clientId, role });

  // Send initial room_state
  safeSend(ws, { type:"room_state", visitors: roomState.sockets.size, role });

  // Broadcast updated visitors and individualized roles
  broadcastRoomState(roomState);

  ws.on("message", (raw) => {
    let msg = null;
    try{
      msg = JSON.parse(raw.toString("utf8"));
    }catch(e){
      return;
    }

    const type = msg.type || "";

    // Keep room state fresh in case client sends hello
    if(type === "hello"){
      // Reclaim again defensively
      reclaimClient(roomState, clientId, ws);
      const info = roomState.clientsById.get(clientId);
      if(info){
        info.ws = ws;
        // keep role
      }else{
        roomState.clientsById.set(clientId, { ws, role });
      }
      safeSend(ws, { type:"room_state", visitors: roomState.sockets.size, role });
      broadcastRoomState(roomState);
      return;
    }

    // Drawing messages broadcast to all sockets in room
    if(type === "draw"){
      const payload = { type:"draw", a: msg.a, b: msg.b };
      for(const s of roomState.sockets){
        if(s !== ws) safeSend(s, payload);
      }
      return;
    }

    if(type === "clear"){
      const payload = { type:"clear" };
      for(const s of roomState.sockets){
        if(s !== ws) safeSend(s, payload);
      }
      return;
    }

    // Voice signaling types, server acts as relay
    // Allowed types
    const voiceTypes = new Set([
      "voice_request",
      "voice_accept",
      "voice_reject",
      "voice_offer",
      "voice_answer",
      "voice_ice",
      "voice_stop"
    ]);

    if(voiceTypes.has(type)){
      // Optionally restrict to participants for request/accept flows
      const senderInfo = roomState.clientsById.get(clientId);
      const senderRole = senderInfo ? senderInfo.role : "Unknown";

      if((type === "voice_request" || type === "voice_accept" || type === "voice_offer" || type === "voice_answer" || type === "voice_ice" || type === "voice_stop") && senderRole !== "Participant"){
        safeSend(ws, { type:"voice_reject", reason:"not_participant" });
        return;
      }

      // Relay to other participants first, otherwise to everyone else in room
      const payload = { ...msg };
      payload.type = type;

      // find peer participant sockets excluding sender
      const peerSockets = [];
      for(const [id, info] of roomState.clientsById.entries()){
        if(id === clientId) continue;
        if(info && info.ws && info.ws.readyState === 1 && info.role === "Participant"){
          peerSockets.push(info.ws);
        }
      }

      if(peerSockets.length > 0){
        for(const s of peerSockets) safeSend(s, payload);
      }else{
        // fallback broadcast
        for(const s of roomState.sockets){
          if(s !== ws) safeSend(s, payload);
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("WS closed", { room, clientId });

    // Remove socket
    roomState.sockets.delete(ws);

    // If this ws is the current ws for clientId, remove mapping
    const info = roomState.clientsById.get(clientId);
    if(info && info.ws === ws){
      roomState.clientsById.delete(clientId);
    }

    // If room empty, delete
    if(roomState.sockets.size === 0){
      rooms.delete(room);
      return;
    }

    // Rebalance roles to keep up to 2 participants among remaining unique clientIds
    // Preserve existing participants first
    const ids = Array.from(roomState.clientsById.keys());

    // Count current participants
    let pCount = 0;
    for(const id of ids){
      const i = roomState.clientsById.get(id);
      if(i && i.role === "Participant") pCount++;
    }

    // If fewer than 2, promote visitors by insertion order
    if(pCount < 2){
      for(const id of ids){
        if(pCount >= 2) break;
        const i = roomState.clientsById.get(id);
        if(i && i.role !== "Participant"){
          i.role = "Participant";
          pCount++;
        }
      }
    }

    // If more than 2, demote extras
    if(pCount > 2){
      let keep = 2;
      for(const id of ids){
        const i = roomState.clientsById.get(id);
        if(!i) continue;
        if(i.role === "Participant"){
          if(keep > 0){
            keep--;
          }else{
            i.role = "Visitor";
          }
        }
      }
    }

    broadcastRoomState(roomState);
  });

  ws.on("error", () => {
    // ignore
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Listening on", PORT);
});
