// server.js
// Unline WebSocket server with room canvas sync, role gating, ready based trial start, ICE config endpoint

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function nowMs() { return Date.now(); }
function id8() { return crypto.randomBytes(4).toString("hex"); }

const PALETTE = [
  "#E8EEF9","#22C55E","#3B82F6","#A855F7","#F59E0B","#EF4444","#14B8A6","#F472B6"
];

function pickColor(used) {
  for (const c of PALETTE) if (!used.has(c)) return c;
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

// Room state model
// rooms.get(room) => {
//   clients: Map(clientId, { ws, clientId, color, joinedAt, ready, role }),
//   ownerId: string | null,
//   participants: Set(clientId),
//   strokes: Array(strokeMsg),
//   sessionMode: "lobby" | "trial" | "trial_ended" | "learning",
//   trialEndsAt: number | null,
//   lastActiveAt: number
// }
const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      clients: new Map(),
      ownerId: null,
      participants: new Set(),
      strokes: [],
      sessionMode: "lobby",
      trialEndsAt: null,
      lastActiveAt: nowMs(),
    });
  }
  return rooms.get(roomCode);
}

function resetRoom(roomCode) {
  rooms.delete(roomCode);
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(roomCode, obj) {
  const r = rooms.get(roomCode);
  if (!r) return;
  for (const c of r.clients.values()) safeSend(c.ws, obj);
}

function buildRoster(r) {
  return Array.from(r.clients.values()).map(c => ({
    clientId: c.clientId,
    shortId: c.clientId.slice(0, 6),
    color: c.color,
    role: c.role,
    ready: !!c.ready,
    isOwner: r.ownerId === c.clientId,
  }));
}

function recomputeRoles(r) {
  for (const c of r.clients.values()) {
    c.role = r.participants.has(c.clientId) ? "Participant" : "Viewer";
  }
}

function roomStateFor(r, selfId) {
  const self = r.clients.get(selfId);
  const roster = buildRoster(r);
  return {
    type: "room_state",
    visitors: r.clients.size,
    sessionMode: r.sessionMode,
    trialEndsAt: r.trialEndsAt,
    self: {
      clientId: selfId,
      shortId: selfId.slice(0, 6),
      color: self ? self.color : "#E8EEF9",
      role: self ? self.role : "Viewer",
      ready: self ? !!self.ready : false,
      isOwner: r.ownerId === selfId,
    },
    roster
  };
}

function maybeStartTrial(roomCode) {
  const r = rooms.get(roomCode);
  if (!r) return;

  // Start only in lobby
  if (r.sessionMode !== "lobby") return;

  const participantIds = Array.from(r.participants);
  if (participantIds.length !== 2) return;

  const a = r.clients.get(participantIds[0]);
  const b = r.clients.get(participantIds[1]);
  if (!a || !b) return;

  if (!a.ready || !b.ready) return;

  r.sessionMode = "trial";
  r.trialEndsAt = nowMs() + 10 * 60 * 1000;

  broadcast(roomCode, {
    type: "session_started",
    sessionMode: r.sessionMode,
    trialEndsAt: r.trialEndsAt
  });

  // Broadcast room_state so UI updates immediately
  for (const c of r.clients.values()) {
    safeSend(c.ws, roomStateFor(r, c.clientId));
  }

  // Auto end trial
  setTimeout(() => {
    const rr = rooms.get(roomCode);
    if (!rr) return;
    if (rr.sessionMode !== "trial") return;
    if (!rr.trialEndsAt) return;
    if (nowMs() < rr.trialEndsAt) return;

    rr.sessionMode = "trial_ended";
    rr.trialEndsAt = null;

    broadcast(roomCode, { type: "session_ended", sessionMode: rr.sessionMode });

    for (const c of rr.clients.values()) {
      safeSend(c.ws, roomStateFor(rr, c.clientId));
    }
  }, 10 * 60 * 1000 + 500);
}

// Serve static (Render uses root)
app.use(express.static("public"));

// ICE servers endpoint
// Environment variables (recommended for mobile reliability)
// TURN_URL=turn:your.turn.host:3478
// TURN_USERNAME=xxx
// TURN_CREDENTIAL=yyy
app.get("/api/ice", (req, res) => {
  const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];

  const turnUrl = (process.env.TURN_URL || "").trim();
  const turnUser = (process.env.TURN_USERNAME || "").trim();
  const turnCred = (process.env.TURN_CREDENTIAL || "").trim();

  if (turnUrl && turnUser && turnCred) {
    iceServers.push({
      urls: [turnUrl],
      username: turnUser,
      credential: turnCred,
    });
  }

  res.json({ ok: true, iceServers, hasTurn: !!(turnUrl && turnUser && turnCred) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/ws")) {
    ws.close();
    return;
  }

  const room = (url.searchParams.get("room") || "TEST").trim();
  const clientId = (url.searchParams.get("clientId") || "").trim() || ("c" + id8());

  const r = getRoom(room);

  // Assign owner if first join
  if (!r.ownerId) r.ownerId = clientId;

  // Color assignment
  const usedColors = new Set(Array.from(r.clients.values()).map(c => c.color));
  const color = pickColor(usedColors);

  r.clients.set(clientId, {
    ws,
    clientId,
    color,
    joinedAt: nowMs(),
    ready: false,
    role: "Viewer",
  });

  // Default roles recompute
  recomputeRoles(r);

  // Send initial room_state and canvas sync to this client
  safeSend(ws, roomStateFor(r, clientId));
  safeSend(ws, { type: "sync_canvas", strokes: r.strokes });

  // Broadcast updated room_state to everyone
  broadcast(room, { type: "roster_changed" });
  for (const c of r.clients.values()) safeSend(c.ws, roomStateFor(r, c.clientId));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const type = msg.type || "";
    r.lastActiveAt = nowMs();

    // Always ensure room still exists
    const rr = rooms.get(room);
    if (!rr) return;

    const self = rr.clients.get(clientId);
    if (!self) return;

    if (type === "hello") {
      safeSend(ws, roomStateFor(rr, clientId));
      safeSend(ws, { type: "sync_canvas", strokes: rr.strokes });
      return;
    }

    if (type === "set_ready") {
      self.ready = !!msg.ready;
      // Re broadcast state
      for (const c of rr.clients.values()) safeSend(c.ws, roomStateFor(rr, c.clientId));
      maybeStartTrial(room);
      return;
    }

    if (type === "set_participant") {
      // Only owner can grant
      if (rr.ownerId !== clientId) return;

      const targetId = (msg.targetId || "").trim();
      const allow = !!msg.allow;

      if (!targetId || !rr.clients.has(targetId)) return;

      if (allow) {
        // Max 2 participants
        if (rr.participants.size >= 2 && !rr.participants.has(targetId)) return;
        rr.participants.add(targetId);
      } else {
        rr.participants.delete(targetId);
        const t = rr.clients.get(targetId);
        if (t) t.ready = false;
      }

      // When participants change, reset ready gating
      for (const cId of rr.clients.keys()) {
        if (!rr.participants.has(cId)) rr.clients.get(cId).ready = false;
      }

      recomputeRoles(rr);
      for (const c of rr.clients.values()) safeSend(c.ws, roomStateFor(rr, c.clientId));
      return;
    }

    if (type === "clear") {
      if (self.role !== "Participant") return;
      rr.strokes = [];
      broadcast(room, { type: "clear" });
      return;
    }

    if (type === "draw") {
      if (self.role !== "Participant") return;
      const stroke = {
        type: "draw",
        a: msg.a,
        b: msg.b,
        mode: msg.mode,
        color: msg.color,
        w: msg.w,
        from: clientId,
      };
      rr.strokes.push(stroke);
      broadcast(room, stroke);
      return;
    }

    // Voice signaling allowed only for Participant with clientId set
    const voiceTypes = new Set(["voice_request","voice_accept","voice_reject","voice_offer","voice_answer","voice_ice","voice_stop"]);
    if (voiceTypes.has(type)) {
      if (self.role !== "Participant") return;
      broadcast(room, { ...msg, from: clientId });
      return;
    }
  });

  ws.on("close", () => {
    const rr = rooms.get(room);
    if (!rr) return;

    rr.clients.delete(clientId);
    rr.participants.delete(clientId);

    // If owner left, assign new owner to earliest joiner
    if (rr.ownerId === clientId) {
      const next = Array.from(rr.clients.values()).sort((a,b) => a.joinedAt - b.joinedAt)[0];
      rr.ownerId = next ? next.clientId : null;
    }

    // If room empty, reset room entirely
    if (rr.clients.size === 0) {
      resetRoom(room);
      return;
    }

    // Recompute roles and rebroadcast
    recomputeRoles(rr);
    broadcast(room, { type: "roster_changed" });
    for (const c of rr.clients.values()) safeSend(c.ws, roomStateFor(rr, c.clientId));
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
