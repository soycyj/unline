너가 준 새 코드들 보면 기존보다 너무 짧아졌어. 이게 맞아? canvas.html만 봐도 비교가 안될만큼 짧아졌어 .  <!doctype html> 
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Unline Canvas</title>
  <style>
    :root{
      --bg:#0b0d10;
      --panel:rgba(20,24,33,0.88);
      --line:rgba(39,48,68,0.9);
      --text:#e8eef9;
      --muted:#a9b4c7;
      --btn:#1f6feb;
      --btn2:#2b3242;
      --danger:#ef4444;
      --ok:#22c55e;
      --warn:#f59e0b;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{
      margin:0;
      background:var(--bg);
      color:var(--text);
      font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,"Noto Sans",Arial;
      overflow:hidden;
    }

    canvas#board{
      position:fixed;
      inset:0;
      width:100vw;
      height:100vh;
      z-index:1;
      touch-action:none;
      background:radial-gradient(1200px 900px at 15% 0%, #13213f 0%, #0b0d10 55%);
    }

    .topBar{
      position:fixed;
      top:12px;
      left:12px;
      right:12px;
      z-index:10;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      padding:10px 12px;
      border:1px solid var(--line);
      background:var(--panel);
      backdrop-filter:blur(10px);
      border-radius:14px;
      box-shadow:0 16px 44px rgba(0,0,0,0.35);
    }
    .leftGroup{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
    .roomCode{font-weight:900;letter-spacing:1px;font-size:14px;white-space:nowrap}
    .small{font-size:12px;color:var(--muted);white-space:nowrap}
    .pill{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:7px 10px;
      border-radius:999px;
      border:1px solid var(--line);
      background:rgba(0,0,0,0.12);
      color:var(--muted);
      font-size:12px;
      white-space:nowrap;
    }
    .dot{
      width:9px;height:9px;border-radius:999px;
      background:#64748b;
      box-shadow:0 0 0 3px rgba(100,116,139,0.15);
    }
    .dot.ok{
      background:var(--ok);
      box-shadow:0 0 0 3px rgba(34,197,94,0.18);
    }
    .dot.warn{
      background:var(--warn);
      box-shadow:0 0 0 3px rgba(245,158,11,0.18);
    }
    .rightGroup{display:flex;align-items:center;gap:10px}

    .controls{
      position:fixed;
      right:14px;
      bottom:14px;
      z-index:10;
      display:grid;
      gap:10px;
      padding:12px;
      border-radius:14px;
      border:1px solid var(--line);
      background:var(--panel);
      backdrop-filter:blur(10px);
      box-shadow:0 16px 44px rgba(0,0,0,0.35);
      min-width:240px;
    }
    .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    button{
      border:0;border-radius:12px;
      padding:10px 12px;
      font-weight:900;
      cursor:pointer;
      color:white;
      background:var(--btn);
      font-size:13px;
      white-space:nowrap;
    }
    button.secondary{background:var(--btn2)}
    button.danger{background:var(--danger)}
    button:disabled{opacity:0.6;cursor:not-allowed}

    .toolBtn{flex:1;background:var(--btn2)}
    .toolBtn.active{background:var(--btn)}
    input[type="color"]{
      width:44px;height:34px;
      border:1px solid var(--line);
      background:transparent;
      border-radius:10px;
      padding:0;
      cursor:pointer;
    }
    input[type="range"]{width:130px}

    .overlay{
      position:fixed;
      inset:0;
      z-index:30;
      display:none;
      align-items:center;
      justify-content:center;
      background:rgba(0,0,0,0.55);
      padding:18px;
    }
    .overlay.show{display:flex}
    .modal{
      width:min(560px, 100%);
      border-radius:14px;
      border:1px solid var(--line);
      background:rgba(20,24,33,0.95);
      backdrop-filter:blur(10px);
      box-shadow:0 24px 80px rgba(0,0,0,0.45);
      padding:14px;
    }
    .modal h3{margin:0 0 10px;font-size:14px}
    .modal input{
      width:100%;
      background:#0e1220;
      border:1px solid var(--line);
      color:var(--text);
      border-radius:12px;
      padding:12px;
      outline:none;
      font-size:14px;
    }
    .modal .hint{margin-top:10px;color:var(--muted);font-size:12px;line-height:1.45}
    .modal .footer{
      display:flex;
      gap:10px;
      justify-content:flex-end;
      margin-top:12px;
      flex-wrap:wrap;
    }
    .banner{
      position:fixed;
      left:12px;
      bottom:12px;
      z-index:11;
      max-width:min(520px, calc(100vw - 24px));
      border:1px solid var(--line);
      background:rgba(0,0,0,0.25);
      backdrop-filter:blur(10px);
      border-radius:14px;
      padding:10px 12px;
      color:var(--muted);
      font-size:12px;
      display:none;
      box-shadow:0 16px 44px rgba(0,0,0,0.35);
    }
    .banner.show{display:block}
    .banner strong{color:var(--text)}

    .trialOverlay{
      position:fixed;
      inset:0;
      z-index:40;
      display:none;
      align-items:center;
      justify-content:center;
      background:rgba(0,0,0,0.62);
      padding:18px;
    }
    .trialOverlay.show{display:flex}
    .trialBox{
      width:min(620px, 100%);
      border-radius:14px;
      border:1px solid var(--line);
      background:rgba(20,24,33,0.95);
      backdrop-filter:blur(10px);
      box-shadow:0 24px 80px rgba(0,0,0,0.45);
      padding:16px;
    }
    .trialBox h3{margin:0 0 8px;font-size:15px}
    .trialBox p{margin:0 0 12px;color:var(--muted);font-size:12px;line-height:1.45}
    .trialBox .footer{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
  </style>
</head>
<body>
  <canvas id="board"></canvas>

  <div class="topBar">
    <div class="leftGroup">
      <div class="roomCode" id="roomCode">ROOM</div>

      <div class="pill" title="Connected clients">
        <span>Visitors</span>
        <strong id="visitors">0</strong>
      </div>

      <div class="pill" title="Participants and watchers">
        <span id="roleText">Role</span>
        <strong id="roleValue">Participant</strong>
      </div>

      <div class="pill" title="Session status">
        <span id="sessionText">Session</span>
        <strong id="sessionValue">Idle</strong>
      </div>

      <div class="pill" title="Trial timer">
        <span>Trial</span>
        <strong id="trialTimer">--:--</strong>
      </div>

      <div class="pill" title="WebSocket connection">
        <span id="sockDot" class="dot"></span>
        <span id="sockText">Connecting</span>
      </div>
    </div>

    <div class="rightGroup">
      <button id="changeBtn" class="secondary">Change room</button>
      <button id="backBtn" class="secondary">Back</button>
    </div>
  </div>

  <div class="controls" id="controls">
    <div class="row">
      <button id="penBtn" class="toolBtn active">Pen</button>
      <button id="eraserBtn" class="toolBtn">Eraser</button>
    </div>
    <div class="row">
      <span class="small">Color</span>
      <input id="color" type="color" value="#ffffff" />
    </div>
    <div class="row">
      <span class="small">Size</span>
      <input id="size" type="range" min="2" max="30" value="6" />
      <span class="small" id="sizeLabel">6</span>
    </div>
    <div class="row">
      <button id="clearBtn" class="danger">Clear</button>
      <button id="copyBtn" class="secondary">Copy code</button>
    </div>
    <div class="row">
      <button id="startVoiceBtn" class="secondary">Start voice</button>
    </div>
  </div>

  <div class="banner" id="banner">
    <strong>Spectator mode</strong> You can watch, but cannot draw or start voice.
  </div>

  <div class="overlay" id="overlay">
    <div class="modal">
      <h3>Change room</h3>
      <input id="roomInput" type="text" inputmode="latin" autocomplete="off" placeholder="Example 4F8K2D" />
      <div class="hint">Room code should be 4 to 8 characters using A to Z and 0 to 9</div>
      <div class="footer">
        <button id="cancelBtn" class="secondary">Cancel</button>
        <button id="goBtn">Go</button>
      </div>
    </div>
  </div>

  <div class="trialOverlay" id="trialOverlay">
    <div class="trialBox">
      <h3>Trial ended</h3>
      <p>Continue to keep practicing in this room.</p>
      <div class="footer">
        <button id="tryAnotherBtn" class="secondary">Try another</button>
        <button id="endHereBtn" class="secondary">End here</button>
        <button id="continueBtn">Continue</button>
      </div>
    </div>
  </div>

  <script>
    const ROOM_RE = /^[A-Z0-9]{4,8}$/;
    const CLIENT_ID_KEY = "unline_client_id_v1";

    const board = document.getElementById("board");
    const ctx = board.getContext("2d");

    const roomCodeEl = document.getElementById("roomCode");
    const visitorsEl = document.getElementById("visitors");

    const roleValue = document.getElementById("roleValue");
    const sessionValue = document.getElementById("sessionValue");
    const trialTimerEl = document.getElementById("trialTimer");
    const sockDot = document.getElementById("sockDot");
    const sockText = document.getElementById("sockText");

    const controls = document.getElementById("controls");
    const banner = document.getElementById("banner");

    const penBtn = document.getElementById("penBtn");
    const eraserBtn = document.getElementById("eraserBtn");
    const colorInput = document.getElementById("color");
    const sizeInput = document.getElementById("size");
    const sizeLabel = document.getElementById("sizeLabel");
    const clearBtn = document.getElementById("clearBtn");
    const copyBtn = document.getElementById("copyBtn");

    const changeBtn = document.getElementById("changeBtn");
    const backBtn = document.getElementById("backBtn");

    const overlay = document.getElementById("overlay");
    const roomInput = document.getElementById("roomInput");
    const cancelBtn = document.getElementById("cancelBtn");
    const goBtn = document.getElementById("goBtn");

    const trialOverlay = document.getElementById("trialOverlay");
    const continueBtn = document.getElementById("continueBtn");
    const tryAnotherBtn = document.getElementById("tryAnotherBtn");
    const endHereBtn = document.getElementById("endHereBtn");

    const startVoiceBtn = document.getElementById("startVoiceBtn");

    function getParams() {
      const u = new URL(location.href);
      return {
        room: u.searchParams.get("room") || "",
      };
    }

    function sanitizeRoom(v) {
      return String(v || "").trim().toUpperCase();
    }

    function safeCopy(text) {
      navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      });
    }

    function makeClientId() {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.from(a).map(x => x.toString(16).padStart(2, "0")).join("");
    }

    function getClientId() {
      let id = localStorage.getItem(CLIENT_ID_KEY);
      if (!id || id.length < 16) {
        id = makeClientId();
        localStorage.setItem(CLIENT_ID_KEY, id);
      }
      return id;
    }

    const clientId = getClientId();

    function computeWsUrl() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      return `${proto}://${location.host}/ws`;
    }

    const { room } = getParams();
    const currentRoom = sanitizeRoom(room);

    if (!ROOM_RE.test(currentRoom)) {
      alert("Invalid room code");
      location.href = "index.html";
    }

    roomCodeEl.textContent = currentRoom;

    function resizeCanvas() {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = Math.floor(window.innerWidth);
      const h = Math.floor(window.innerHeight);

      board.width = Math.floor(w * dpr);
      board.height = Math.floor(h * dpr);
      board.style.width = w + "px";
      board.style.height = h + "px";

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "source-over";
    }

    function clearLocalPixels() {
      const rect = board.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.globalCompositeOperation = "source-over";
    }

    function getNormPoint(evt) {
      const rect = board.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      const nx = rect.width ? x / rect.width : 0;
      const ny = rect.height ? y / rect.height : 0;
      return { nx, ny };
    }

    resizeCanvas();
    window.addEventListener("resize", () => { resizeCanvas(); redrawAll(); });

    sizeInput.addEventListener("input", () => { sizeLabel.textContent = String(sizeInput.value); });

    let tool = "pen";
    function setTool(next) {
      tool = next === "eraser" ? "eraser" : "pen";
      penBtn.classList.toggle("active", tool === "pen");
      eraserBtn.classList.toggle("active", tool === "eraser");
    }
    penBtn.addEventListener("click", () => setTool("pen"));
    eraserBtn.addEventListener("click", () => setTool("eraser"));

    function openOverlay() {
      overlay.classList.add("show");
      roomInput.value = "";
      roomInput.focus();
    }
    function closeOverlay() {
      overlay.classList.remove("show");
    }
    function goRoom(value) {
      const clean = sanitizeRoom(value);
      if (!ROOM_RE.test(clean)) {
        alert("Invalid room code");
        return;
      }
      location.href = `canvas.html?room=${encodeURIComponent(clean)}`;
    }

    changeBtn.addEventListener("click", openOverlay);
    backBtn.addEventListener("click", () => { location.href = "index.html"; });
    cancelBtn.addEventListener("click", closeOverlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
    goBtn.addEventListener("click", () => goRoom(roomInput.value));
    roomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") goRoom(roomInput.value);
      if (e.key === "Escape") closeOverlay();
    });

    let allStrokes = [];

    function drawSegment(seg) {
      const rect = board.getBoundingClientRect();
      const x0 = seg.x0n * rect.width;
      const y0 = seg.y0n * rect.height;
      const x1 = seg.x1n * rect.width;
      const y1 = seg.y1n * rect.height;

      ctx.save();
      if (seg.tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = String(seg.color || "#ffffff");
      }
      ctx.lineWidth = Number(seg.size || 6);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();
    }

    function redrawAll() {
      clearLocalPixels();
      for (const s of allStrokes) drawSegment(s);
    }

    function setAllStrokes(strokes) {
      allStrokes = Array.isArray(strokes) ? strokes.slice() : [];
      redrawAll();
    }

    function addStrokeLocal(seg) {
      allStrokes.push(seg);
      if (allStrokes.length > 8000) allStrokes.splice(0, allStrokes.length - 8000);
    }

    function clearAllStrokes() {
      allStrokes = [];
      clearLocalPixels();
    }

    let ws = null;
    let reconnectAttempt = 0;
    let connectTimeoutId = null;
    let heartbeatId = null;
    let lastPongAt = Date.now();

    let myRole = "participant";
    let sessionState = "idle";
    let trialEndsAt = 0;
    let timerTickId = null;

    function setRole(role) {
      myRole = role === "spectator" ? "spectator" : "participant";
      roleValue.textContent = myRole === "spectator" ? "Watcher" : "Participant";
      const isSpectator = myRole === "spectator";
      controls.style.display = isSpectator ? "none" : "grid";
      banner.classList.toggle("show", isSpectator);
      drawing = false;
      last = null;
    }

    function computeTrialLabel(state) {
      if (state === "trial") return "Trial";
      if (state === "continued") return "Continued";
      if (state === "ended") return "Ended";
      return "Idle";
    }

    function setSession(state, endsAtMs) {
      sessionState = String(state || "idle");
      sessionValue.textContent = computeTrialLabel(sessionState);

      if (typeof endsAtMs === "number" && endsAtMs > 0) trialEndsAt = endsAtMs;
      else if (sessionState !== "trial") trialEndsAt = 0;

      if (timerTickId) clearInterval(timerTickId);
      timerTickId = setInterval(updateTimer, 250);
      updateTimer();

      if (sessionState === "ended" && myRole === "participant") trialOverlay.classList.add("show");
      else trialOverlay.classList.remove("show");
    }

    function updateTimer() {
      if (sessionState !== "trial" || !trialEndsAt) {
        trialTimerEl.textContent = "--:--";
        return;
      }
      const leftMs = Math.max(0, trialEndsAt - Date.now());
      const sec = Math.floor(leftMs / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      trialTimerEl.textContent = `${mm}:${ss}`;
    }

    function wsSend(obj) {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch {}
    }

    function stopHeartbeat() {
      if (heartbeatId) clearInterval(heartbeatId);
      heartbeatId = null;
    }

    function startHeartbeat() {
      stopHeartbeat();
      lastPongAt = Date.now();
      heartbeatId = setInterval(() => {
        if (!ws || ws.readyState !== 1) return;
        wsSend({ type: "ping" });
        if (Date.now() - lastPongAt > 45000) {
          try { ws.close(); } catch {}
        }
      }, 20000);
    }

    function scheduleReconnect() {
      const delay = Math.min(8000, 1000 * Math.pow(2, reconnectAttempt));
      reconnectAttempt += 1;
      setTimeout(() => connectWs(), delay);
    }

    function connectWs() {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

      sockText.textContent = "Connecting";
      sockDot.classList.remove("ok");
      sockDot.classList.remove("warn");

      const wsUrl = computeWsUrl();

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }

      if (connectTimeoutId) clearTimeout(connectTimeoutId);
      connectTimeoutId = setTimeout(() => {
        if (ws && ws.readyState === 0) {
          try { ws.close(); } catch {}
        }
      }, 8000);

      ws.addEventListener("open", () => {
        reconnectAttempt = 0;
        sockDot.classList.add("ok");
        sockText.textContent = "Online";
        wsSend({ type: "join", roomCode: currentRoom, clientId });
        startHeartbeat();
      });

      ws.addEventListener("close", () => {
        stopHeartbeat();
        sockDot.classList.remove("ok");
        sockDot.classList.add("warn");
        sockText.textContent = "Offline";
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        stopHeartbeat();
        sockDot.classList.remove("ok");
        sockDot.classList.add("warn");
        sockText.textContent = "Offline";
      });

      ws.addEventListener("message", (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "pong") {
          lastPongAt = Date.now();
          return;
        }

        if (msg.type === "warn") {
          if (msg.reason) alert(String(msg.reason));
          return;
        }

        if (msg.type === "status" && msg.roomCode === currentRoom) {
          visitorsEl.textContent = String(msg.count || 0);
          if (msg.role) setRole(msg.role);
          if (msg.sessionState) setSession(msg.sessionState, msg.trialEndsAt || 0);
          return;
        }

        if (msg.type === "init" && msg.roomCode === currentRoom) {
          const strokes = Array.isArray(msg.strokes) ? msg.strokes : [];
          setAllStrokes(strokes);
          if (msg.role) setRole(msg.role);
          if (msg.sessionState) setSession(msg.sessionState, msg.trialEndsAt || 0);
          visitorsEl.textContent = String(msg.count || 0);
          return;
        }

        if (msg.type === "session" && msg.roomCode === currentRoom) {
          if (msg.sessionState) setSession(msg.sessionState, msg.trialEndsAt || 0);
          return;
        }

        if (msg.type === "stroke" && msg.roomCode === currentRoom && msg.stroke) {
          addStrokeLocal(msg.stroke);
          drawSegment(msg.stroke);
          return;
        }

        if (msg.type === "clear" && msg.roomCode === currentRoom) {
          clearAllStrokes();
          return;
        }

        if (msg.type === "voice_error") {
          alert(String(msg.reason || "Voice error"));
          return;
        }
      });
    }

    connectWs();

    clearBtn.addEventListener("click", () => {
      if (myRole === "spectator") return;
      clearAllStrokes();
      wsSend({ type: "clear", roomCode: currentRoom });
    });

    copyBtn.addEventListener("click", () => safeCopy(currentRoom));

    continueBtn.addEventListener("click", () => {
      wsSend({ type: "continue", roomCode: currentRoom });
      trialOverlay.classList.remove("show");
    });

    tryAnotherBtn.addEventListener("click", () => { location.href = "index.html"; });
    endHereBtn.addEventListener("click", () => { location.href = "index.html"; });

    startVoiceBtn.addEventListener("click", () => {
      if (myRole === "spectator") {
        alert("Spectator cannot start voice");
        return;
      }
      wsSend({ type: "voice_start_request", roomCode: currentRoom });
    });

    let drawing = false;
    let last = null;

    board.addEventListener("pointerdown", (e) => {
      if (myRole === "spectator") return;
      drawing = true;
      board.setPointerCapture(e.pointerId);
      last = getNormPoint(e);
    });

    board.addEventListener("pointermove", (e) => {
      if (myRole === "spectator") return;
      if (!drawing || !last) return;
      const p = getNormPoint(e);

      const seg = {
        x0n: last.nx,
        y0n: last.ny,
        x1n: p.nx,
        y1n: p.ny,
        color: colorInput.value,
        size: Number(sizeInput.value),
        tool: tool
      };

      addStrokeLocal(seg);
      drawSegment(seg);
      wsSend({ type: "stroke", roomCode: currentRoom, stroke: seg });

      last = p;
    });

    function endDraw(e) {
      if (!drawing) return;
      drawing = false;
      last = null;
      try { board.releasePointerCapture(e.pointerId); } catch {}
    }

    board.addEventListener("pointerup", endDraw);
    board.addEventListener("pointercancel", endDraw);
  </script>
</body>
</html>