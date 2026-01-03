const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK");
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) rooms.set(roomCode, []);
  return rooms.get(roomCode);
}

function broadcast(roomCode, data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.roomCode === roomCode) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch (e) {
      return;
    }

    if (msg.type === "join") {
      ws.roomCode = msg.roomCode;
      const strokes = getRoom(msg.roomCode);
      ws.send(JSON.stringify({ type: "init", strokes }));
      return;
    }

    if (msg.type === "stroke") {
      const roomCode = ws.roomCode;
      if (!roomCode) return;

      const strokes = getRoom(roomCode);
      strokes.push(msg.stroke);
      broadcast(roomCode, { type: "stroke", stroke: msg.stroke });
      return;
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
