(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- Constants ----------
  const COLS = 22, ROWS = 22, CELL = 50; // bigger than what you can see at once
  const SKIN = 32; // 32x32 paintable pixels per character
  const MOVE_SPEED = 3.4; // cells / second
  const STAGE_ZOOM = 5; // how much closer the paint view is than the normal camera
  const CHAR_WORLD_R = CELL * 0.34; // character radius in world (map-pixel) units, constant regardless of zoom
  const HISTORY_LIMIT = 40;
  const TOUCH_RADIUS = (CHAR_WORLD_R * 2) / CELL; // grid-unit distance at which two characters visibly overlap
  const TAG_RESEND_MS = 400; // how often we'll re-attempt a tag against the same target while overlapping

  let PALETTE = [];
  let TEAM_COLORS = ['#6B3F69', '#5C7A4A', '#E3A93B', '#2F6E68'];

  const S = {
    ws: null,
    code: null,
    playerId: null,
    hostId: null,
    phase: 'home', // home | lobby | hiding | seeking | results
    players: new Map(), // id -> {..., renderX, renderY, skin, skinCanvas}
    map: null,
    mapCanvas: null,
    availableMaps: [],
    mapFile: null,
    phaseEnd: null,
    keys: {},
    lastSent: { x: null, y: null },
    // Camera: a single unified camera drives both normal play and the
    // zoomed-in paint view, so "painting" is just zooming the same camera
    // in on the player rather than opening a separate view.
    viewScale: 1,
    camCenterX: (COLS * CELL) / 2,
    camCenterY: (ROWS * CELL) / 2,
    brush: '#6B3F69',
    brushSize: 1,
    skinDirty: false,
    painting: false,
    paintMode: false,
    hoverWorld: null, // {x,y} in world px — where the brush-size preview is shown
    history: [], // undo/redo stack of skin snapshots
    historyIndex: -1,
    loopHandle: null,
    tagAttempts: new Map(), // targetId -> timestamp of our last tag attempt, so overlap doesn't spam the server
    hudInterval: null,
  };

  function myRole() {
    const me = S.players.get(S.playerId);
    return me ? me.role : null;
  }

  // ---------- Toast ----------
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = msg;
    $('toast').appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------- Screens ----------
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    $('screen-' + name).classList.remove('hidden');
  }

  // ---------- WebSocket ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    S.ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });
    S.ws.addEventListener('close', () => toast('Disconnected from server.'));
    return new Promise((resolve, reject) => {
      S.ws.addEventListener('open', resolve, { once: true });
      S.ws.addEventListener('error', reject, { once: true });
    });
  }

  function send(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'created':
      case 'joined': {
        S.code = msg.code;
        S.playerId = msg.playerId;
        S.hostId = msg.hostId;
        PALETTE = msg.palette;
        TEAM_COLORS = msg.teamColors;
        setPlayers(msg.players);
        buildSwatches();
        S.availableMaps = msg.maps || [];
        S.mapFile = msg.mapFile || null;
        S.phase = msg.phase || 'lobby';
        showScreen('lobby');
        updateLobby();
        break;
      }
      case 'map_selected': {
        S.mapFile = msg.mapFile || null;
        updateLobby();
        break;
      }
      case 'error': {
        toast(msg.message);
        break;
      }
      case 'room_update': {
        S.hostId = msg.hostId;
        setPlayers(msg.players);
        if (S.phase === 'lobby') updateLobby();
        break;
      }
      case 'phase_change': {
        S.phase = msg.phase;
        if (msg.hostId) S.hostId = msg.hostId;
        if (msg.phase === 'lobby') {
          setPlayers(msg.players);
          if (msg.maps) S.availableMaps = msg.maps;
          S.mapFile = msg.mapFile || null;
          showScreen('lobby');
          updateLobby();
          stopGameLoop();
        } else if (msg.phase === 'hiding') {
          S.map = msg.map;
          buildMapCanvas();
          setPlayers(msg.players);
          // Every round starts with a fresh spawn position from the server.
          // renderX/renderY are only ever nudged by movement input, so
          // without this they'd stay wherever they were left last round —
          // showing up in the wrong spot (on your own screen and everyone
          // else's) until you actually move. Snap them to the real spawn.
          S.players.forEach(p => { p.renderX = p.x; p.renderY = p.y; });
          S.phaseEnd = msg.phaseEnd;
          showScreen('game');
          exitPaintMode(true);
          resetCameraImmediate();
          updateControlsForRole();
          resetHistory();
          setBanner(myRole() === 'hider' ? 'Find a spot and paint yourself to match!' : null);
          startGameLoop();
        } else if (msg.phase === 'seeking') {
          setPlayers(msg.players);
          S.tagAttempts.clear();
          S.phaseEnd = msg.phaseEnd;
          updateControlsForRole();
          setBanner(myRole() === 'seeker' ? 'Go find them!' : 'Stay hidden — or run!');
          startGameLoop();
        } else if (msg.phase === 'results') {
          stopGameLoop();
          exitPaintMode(true);
          showScreen('results');
          renderResults(msg.hiders, msg.seekers, msg.outcome);
        }
        break;
      }
      case 'player_moved': {
        const p = S.players.get(msg.id);
        if (p) { p.x = msg.x; p.y = msg.y; }
        break;
      }
      case 'player_skin': {
        const p = S.players.get(msg.id);
        if (p) { p.skin = msg.skin; buildSkinCanvas(p); }
        break;
      }
      case 'player_hit': {
        const p = S.players.get(msg.id);
        if (p) p.hitCount = msg.hitCount;
        toast('Grazed! One more and you\'re caught.');
        break;
      }
      case 'player_tagged': {
        const p = S.players.get(msg.id);
        if (p) { p.tagged = true; p.tagTime = msg.tagTime; }
        if (msg.id === S.playerId) toast('You were spotted!');
        else if (msg.byId === S.playerId) toast('Found one!');
        break;
      }
    }
  }

  // ---------- Players ----------
  function setPlayers(list) {
    const seen = new Set();
    list.forEach(p => {
      seen.add(p.id);
      const existing = S.players.get(p.id);
      if (existing) {
        Object.assign(existing, p);
        if (p.x == null) { existing.renderX = null; existing.renderY = null; }
        if (p.skin) buildSkinCanvas(existing);
      } else {
        const fresh = { ...p, renderX: p.x, renderY: p.y, wobbleSeed: Math.random() * 1000 };
        S.players.set(p.id, fresh);
        if (p.skin) buildSkinCanvas(fresh);
      }
    });
    [...S.players.keys()].forEach(id => { if (!seen.has(id)) S.players.delete(id); });
  }

  // Tiny off-DOM canvas used as a fast image source for drawing a player's
  // painted skin onto their blob (scaled up, no smoothing = crisp
  // hand-painted pixel look).
  function buildSkinCanvas(p) {
    if (!p.skin || p.skin.length !== SKIN * SKIN) return;
    if (!p.skinCanvas) p.skinCanvas = document.createElement('canvas');
    p.skinCanvas.width = SKIN;
    p.skinCanvas.height = SKIN;
    const c = p.skinCanvas.getContext('2d');
    for (let y = 0; y < SKIN; y++) {
      for (let x = 0; x < SKIN; x++) {
        c.fillStyle = p.skin[y * SKIN + x];
        c.fillRect(x, y, 1, 1);
      }
    }
  }

  // ---------- Lobby ----------
  function updateLobby() {
    $('lobby-code').textContent = S.code;
    const wrap = $('lobby-players');
    wrap.innerHTML = '';
    [...S.players.values()].forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'player-chip' + (p.id === S.hostId ? ' chip-host' : '');
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = TEAM_COLORS[p.colorIndex];
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === S.playerId ? ' (you)' : '');
      chip.append(dot, name);
      wrap.appendChild(chip);
    });

    const isHost = S.hostId === S.playerId;
    const startBtn = $('btn-start');
    startBtn.classList.toggle('hidden', !isHost);
    const hint = $('lobby-hint');
    if (isHost) {
      hint.textContent = 'Start when everyone\'s ready — roles are assigned automatically.';
    } else {
      hint.textContent = 'Waiting for the host to start…';
    }
    updateMapPicker(isHost);
  }
  $('btn-start').addEventListener('click', () => send({ type: 'start' }));

  // ---------- Map picker (lobby) ----------
  function updateMapPicker(isHost) {
    const wrap = $('map-picker');
    if (!wrap) return;
    const select = $('map-select');
    const note = $('map-picker-note');
    wrap.classList.toggle('hidden', !isHost && S.availableMaps.length === 0);

    if (S.availableMaps.length === 0) {
      select.classList.add('hidden');
      note.classList.remove('hidden');
      note.textContent = 'No maps uploaded yet — a plain room will be used.';
      return;
    }
    note.classList.add('hidden');
    select.classList.remove('hidden');
    select.disabled = !isHost;

    const optionValues = ['', ...S.availableMaps];
    const currentOptions = [...select.options].map(o => o.value);
    if (currentOptions.join('|') !== optionValues.join('|')) {
      select.innerHTML = '';
      optionValues.forEach(file => {
        const opt = document.createElement('option');
        opt.value = file;
        opt.textContent = file ? mapDisplayName(file) : 'Random map';
        select.appendChild(opt);
      });
    }
    select.value = S.mapFile || '';
  }
  function mapDisplayName(file) {
    return file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  }
  const mapSelectEl = $('map-select');
  if (mapSelectEl) {
    mapSelectEl.addEventListener('change', () => {
      send({ type: 'set_map', file: mapSelectEl.value });
    });
  }

  // ---------- Home screen ----------
  $('btn-show-create').addEventListener('click', () => {
    $('home-actions').classList.remove('hidden');
    $('join-fields').classList.add('hidden');
    doCreate();
  });
  $('btn-show-join').addEventListener('click', () => {
    $('join-fields').classList.remove('hidden');
  });
  $('btn-cancel-join').addEventListener('click', () => {
    $('join-fields').classList.add('hidden');
  });
  $('btn-join').addEventListener('click', () => doJoin());
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  async function ensureConnected() {
    if (!S.ws || S.ws.readyState !== 1) {
      try { await connect(); } catch { toast('Could not reach the server.'); throw new Error('no-conn'); }
    }
  }

  async function doCreate() {
    try { await ensureConnected(); } catch { return; }
    const name = $('name-input').value.trim() || 'Painter';
    send({ type: 'create', name });
  }

  async function doJoin() {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter a 4-letter room code.'); return; }
    try { await ensureConnected(); } catch { return; }
    const name = $('name-input').value.trim() || 'Painter';
    send({ type: 'join', code, name });
  }

  $('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard?.writeText(S.code).then(() => toast('Code copied!')).catch(() => {});
  });

  $('btn-leave-lobby').addEventListener('click', leaveRoom);
  $('btn-leave-results').addEventListener('click', leaveRoom);
  function leaveRoom() {
    send({ type: 'leave' });
    stopGameLoop();
    S.players.clear();
    S.phase = 'home';
    showScreen('home');
  }

  $('btn-play-again').addEventListener('click', () => send({ type: 'play_again' }));

  // ---------- Map rendering: image-based maps ----------
  // The host picks a map image (from the server's /maps folder); every
  // client just loads that same image and stretches it to fill the fixed
  // world size (cols x rows cells). No procedural generation, no per-client
  // drift — everyone loads the same file.
  const FALLBACK_MAP_COLOR = '#3A3F4A';
  const mapImageCache = new Map(); // url -> HTMLImageElement (loaded)

  function loadMapImage(url) {
    if (mapImageCache.has(url)) return Promise.resolve(mapImageCache.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { mapImageCache.set(url, img); resolve(img); };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function buildMapCanvas() {
    const w = S.map.cols * CELL, h = S.map.rows * CELL;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d');
    S.mapCanvas = off;

    // Draw a plain placeholder immediately so the game is playable even
    // before (or if) the image finishes loading.
    c.fillStyle = FALLBACK_MAP_COLOR;
    c.fillRect(0, 0, w, h);

    const file = S.map && S.map.file;
    if (!file) return;
    const img = await loadMapImage(`/maps/${encodeURIComponent(file)}`);
    // Bail out if a newer map has since been loaded (fast phase changes).
    if (S.mapCanvas !== off) return;
    if (img) c.drawImage(img, 0, 0, w, h);
  }

  // Reads the actual rendered color of the map at a given point in map
  // pixel-space. Works no matter how the background was generated.
  function sampleMapPixel(mapPx, mapPy) {
    if (!S.mapCanvas) return '#888888';
    const c = S.mapCanvas.getContext('2d');
    const x = Math.max(0, Math.min(S.mapCanvas.width - 1, Math.floor(mapPx)));
    const y = Math.max(0, Math.min(S.mapCanvas.height - 1, Math.floor(mapPy)));
    const d = c.getImageData(x, y, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // ---------- Paint controls ----------
  function buildSwatches() {
    const wrap = $('swatches');
    wrap.innerHTML = '';
    PALETTE.forEach(hex => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', () => setBrush(hex));
      wrap.appendChild(b);
    });
    setBrush(S.brush);
  }

  function setBrush(hex) {
    S.brush = hex;
    $('brush-preview').style.background = hex;
    $('color-picker').value = hex;
    document.querySelectorAll('.swatch').forEach(el => {
      el.classList.toggle('selected', el.style.background === hexToRgbStr(hex) || el.title.toLowerCase() === hex.toLowerCase());
    });
  }

  function hexToRgbStr(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }

  $('color-picker').addEventListener('input', (e) => setBrush(e.target.value));

  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.brushSize = parseInt(btn.dataset.size, 10);
      document.querySelectorAll('.size-btn').forEach(b => b.classList.toggle('selected', b === btn));
    });
  });

  function fillSkin(hex) {
    const me = S.players.get(S.playerId);
    if (!me) return;
    me.skin = new Array(SKIN * SKIN).fill(hex);
    buildSkinCanvas(me);
    flushSkinNow();
    historyPush();
  }

  $('btn-reset-skin').addEventListener('click', () => {
    const me = S.players.get(S.playerId);
    if (!me) return;
    fillSkin(TEAM_COLORS[me.colorIndex % TEAM_COLORS.length]);
  });

  let lastSkinSend = 0;
  function flushSkinNow() {
    const me = S.players.get(S.playerId);
    if (!me || !me.skin) return;
    S.skinDirty = false;
    lastSkinSend = performance.now();
    send({ type: 'paint_skin', skin: me.skin });
  }

  // ---------- Undo / redo ----------
  function resetHistory() {
    S.history = [];
    S.historyIndex = -1;
    const me = S.players.get(S.playerId);
    if (me && me.skin) historyPush();
    else updateUndoRedoButtons();
  }
  function historyPush() {
    const me = S.players.get(S.playerId);
    if (!me || !me.skin) return;
    S.history = S.history.slice(0, S.historyIndex + 1);
    S.history.push(me.skin.slice());
    if (S.history.length > HISTORY_LIMIT) S.history.shift();
    S.historyIndex = S.history.length - 1;
    updateUndoRedoButtons();
  }
  function historyUndo() {
    if (S.historyIndex <= 0) return;
    S.historyIndex--;
    applyHistorySkin(S.history[S.historyIndex]);
  }
  function historyRedo() {
    if (S.historyIndex >= S.history.length - 1) return;
    S.historyIndex++;
    applyHistorySkin(S.history[S.historyIndex]);
  }
  function applyHistorySkin(skin) {
    const me = S.players.get(S.playerId);
    if (!me) return;
    me.skin = skin.slice();
    buildSkinCanvas(me);
    flushSkinNow();
    updateUndoRedoButtons();
  }
  function updateUndoRedoButtons() {
    $('btn-undo').disabled = S.historyIndex <= 0;
    $('btn-redo').disabled = S.historyIndex >= S.history.length - 1;
  }
  $('btn-undo').addEventListener('click', historyUndo);
  $('btn-redo').addEventListener('click', historyRedo);

  // ---------- Paint mode: zoom into the player to paint, in place ----------
  // There's no separate modal — "painting" is the same camera zoomed in on
  // the player, with controls sliding into the side margin. Clicking the
  // paint button again zooms back out.
  function updateControlsForRole() {
    const iAmHider = myRole() === 'hider';
    $('btn-open-paint').classList.toggle('hidden', !iAmHider);
  }

  $('btn-open-paint').addEventListener('click', () => {
    if (S.paintMode) exitPaintMode(); else enterPaintMode();
  });

  function enterPaintMode() {
    S.paintMode = true;
    S.hoverWorld = null;
    $('panel-paint').classList.add('panel-visible');
    $('btn-open-paint').textContent = '🔍 Zoom back out';
    $('btn-open-paint').classList.add('painting');
    $('move-hint').classList.add('hidden');
  }
  function exitPaintMode(snapCamera) {
    S.paintMode = false;
    S.painting = false;
    S.hoverWorld = null;
    $('panel-paint').classList.remove('panel-visible');
    $('btn-open-paint').textContent = '🎨 Paint yourself';
    $('btn-open-paint').classList.remove('painting');
    $('move-hint').classList.remove('hidden');
    if (snapCamera) { S.viewScale = 1; }
  }
  function resetCameraImmediate() {
    const target = cameraTarget(S.viewScale);
    S.camCenterX = target.x;
    S.camCenterY = target.y;
  }

  // ---------- Game canvas / unified camera ----------
  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');
  const canvasWrap = document.querySelector('.canvas-wrap-full');

  function resizeCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width));
    const h = Math.max(200, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvasWrap);
  else window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function clampCenter(target, viewSize, mapSize) {
    if (viewSize >= mapSize) return mapSize / 2;
    return Math.max(viewSize / 2, Math.min(mapSize - viewSize / 2, target));
  }

  // Where the camera wants to be for a given zoom scale: normal play tracks
  // the player loosely (clamped to the map edges); paint mode tracks the
  // player exactly, since the whole point is to center them for painting.
  function cameraTarget(scale) {
    const me = S.players.get(S.playerId);
    const px = me && me.renderX != null ? me.renderX * CELL : (COLS * CELL) / 2;
    const py = me && me.renderY != null ? me.renderY * CELL : (ROWS * CELL) / 2;
    const mapW = COLS * CELL, mapH = ROWS * CELL;
    const viewW = canvas.width / scale, viewH = canvas.height / scale;
    return { x: clampCenter(px, viewW, mapW), y: clampCenter(py, viewH, mapH) };
  }

  function updateCamera(dt) {
    const targetScale = S.paintMode ? STAGE_ZOOM : 1;
    const ease = Math.min(1, dt * 7);
    S.viewScale += (targetScale - S.viewScale) * ease;
    if (Math.abs(targetScale - S.viewScale) < 0.01) S.viewScale = targetScale;
    const target = cameraTarget(S.viewScale);
    S.camCenterX += (target.x - S.camCenterX) * ease;
    S.camCenterY += (target.y - S.camCenterY) * ease;
  }

  function worldToScreen(wx, wy) {
    return {
      x: (wx - S.camCenterX) * S.viewScale + canvas.width / 2,
      y: (wy - S.camCenterY) * S.viewScale + canvas.height / 2
    };
  }
  function screenToWorld(px, py) {
    return {
      x: (px - canvas.width / 2) / S.viewScale + S.camCenterX,
      y: (py - canvas.height / 2) / S.viewScale + S.camCenterY
    };
  }

  function blobPath(cx, cy, baseR) {
    const path = new Path2D();
    path.arc(cx, cy, baseR, 0, Math.PI * 2);
    return path;
  }

  function drawPlayer(p, t) {
    if (p.renderX == null || p.renderY == null) return; // hidden from us right now
    const { x: cx, y: cy } = worldToScreen(p.renderX * CELL, p.renderY * CELL);
    const baseR = CHAR_WORLD_R * S.viewScale;
    if (cx < -baseR - 60 || cy < -baseR - 60 || cx > canvas.width + baseR + 60 || cy > canvas.height + baseR + 60) return;
    const isMe = p.id === S.playerId;
    const showName = isMe || S.phase !== 'seeking' || S.phase === 'results';
    const path = blobPath(cx, cy, baseR);

    ctx.save();
    if (p.tagged) ctx.globalAlpha = 0.35;

    ctx.save();
    ctx.clip(path);
    ctx.imageSmoothingEnabled = false;
    if (p.skinCanvas) {
      ctx.drawImage(p.skinCanvas, cx - baseR, cy - baseR, baseR * 2, baseR * 2);
    } else {
      ctx.fillStyle = TEAM_COLORS[p.colorIndex] || '#888';
      ctx.fillRect(cx - baseR, cy - baseR, baseR * 2, baseR * 2);
    }
    ctx.restore();

    if (isMe && !p.tagged) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(35,41,70,0.9)';
      ctx.stroke(path);
      ctx.restore();
    }

    if (p.tagged) {
      ctx.strokeStyle = '#C1554D';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - baseR * 0.6, cy - baseR * 0.6);
      ctx.lineTo(cx + baseR * 0.6, cy + baseR * 0.6);
      ctx.moveTo(cx + baseR * 0.6, cy - baseR * 0.6);
      ctx.lineTo(cx - baseR * 0.6, cy + baseR * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    if (showName && !p.tagged) {
      ctx.save();
      ctx.font = '600 11px "Space Grotesk", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(35,41,70,0.55)';
      ctx.fillText(p.name + (isMe ? ' (you)' : ''), cx, cy - baseR - 8);
      ctx.restore();
    }
  }

  // Shows the paintbrush footprint on the character before you click, so
  // you always know exactly how big a stroke you're about to make.
  function drawBrushPreview() {
    const me = S.players.get(S.playerId);
    if (!me || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    const hover = S.hoverWorld || { x: meWorldX, y: meWorldY };
    const { gx, gy, inside } = skinCoordAt(hover.x, hover.y, meWorldX, meWorldY);
    if (!inside && S.hoverWorld) return; // hovering outside the character — no footprint to show
    const bs = S.brushSize || 1;
    const half = Math.floor((bs - 1) / 2);
    const px2world = (CHAR_WORLD_R * 2) / SKIN;
    const wx0 = meWorldX - CHAR_WORLD_R + (gx - half) * px2world;
    const wy0 = meWorldY - CHAR_WORLD_R + (gy - half) * px2world;
    const size = bs * px2world;
    const p0 = worldToScreen(wx0, wy0);
    const p1 = worldToScreen(wx0 + size, wy0 + size);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = S.brush;
    ctx.fillStyle = S.brush;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.globalAlpha = 0.9;
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.restore();
  }

  function draw(t, dt) {
    updateCamera(dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (S.mapCanvas) {
      const viewW = canvas.width / S.viewScale, viewH = canvas.height / S.viewScale;
      const srcX = S.camCenterX - viewW / 2, srcY = S.camCenterY - viewH / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(S.mapCanvas, srcX, srcY, viewW, viewH, 0, 0, canvas.width, canvas.height);
    }
    // Hiders always draw first (i.e. behind everyone else). If a seeker
    // walks over a hider, the hider's blob must stay underneath so no
    // z-order pop-up gives away the touch before the tag is confirmed.
    const drawOrder = [...S.players.values()].sort((a, b) => {
      const aTop = a.role === 'hider' ? 0 : 1;
      const bTop = b.role === 'hider' ? 0 : 1;
      return aTop - bTop;
    });
    drawOrder.forEach(p => drawPlayer(p, t));
    if (S.paintMode) drawBrushPreview();
  }

  // ---------- Painting on the character, in place ----------
  // Given a world point, returns the skin-pixel coordinate it falls on
  // (relative to `meWorldX/Y`, the character's own world position) and
  // whether that point actually lands inside the character.
  function skinCoordAt(worldX, worldY, meWorldX, meWorldY) {
    const ox = worldX - meWorldX, oy = worldY - meWorldY;
    const inside = Math.hypot(ox, oy) <= CHAR_WORLD_R;
    const gx = Math.floor(((ox + CHAR_WORLD_R) / (CHAR_WORLD_R * 2)) * SKIN);
    const gy = Math.floor(((oy + CHAR_WORLD_R) / (CHAR_WORLD_R * 2)) * SKIN);
    return { gx, gy, inside };
  }

  function paintAtWorld(worldX, worldY) {
    const me = S.players.get(S.playerId);
    if (!me || !me.skin || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    const { gx, gy } = skinCoordAt(worldX, worldY, meWorldX, meWorldY);
    const bs = S.brushSize || 1;
    const half = Math.floor((bs - 1) / 2);
    let changed = false;
    for (let yy = gy - half; yy < gy - half + bs; yy++) {
      for (let xx = gx - half; xx < gx - half + bs; xx++) {
        if (xx < 0 || xx >= SKIN || yy < 0 || yy >= SKIN) continue;
        const idx = yy * SKIN + xx;
        if (me.skin[idx] !== S.brush) { me.skin[idx] = S.brush; changed = true; }
      }
    }
    if (changed) { buildSkinCanvas(me); S.skinDirty = true; }
  }

  function eyedropAtWorld(worldX, worldY) {
    setBrush(sampleMapPixel(worldX, worldY));
    toast('Color picked!');
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.paintMode) return; // outside paint mode, clicking the canvas does nothing —
                               // tagging happens automatically by walking into a hider
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX, py = (e.clientY - rect.top) * scaleY;
    const world = screenToWorld(px, py);

    e.preventDefault();
    const me = S.players.get(S.playerId);
    if (!me || me.x == null) return;
    const meWorldX = me.renderX != null ? me.renderX * CELL : me.x * CELL;
    const meWorldY = me.renderY != null ? me.renderY * CELL : me.y * CELL;
    S.hoverWorld = world;
    const { inside } = skinCoordAt(world.x, world.y, meWorldX, meWorldY);
    if (inside) {
      S.painting = true;
      paintAtWorld(world.x, world.y);
    } else {
      eyedropAtWorld(world.x, world.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!S.paintMode) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX, py = (e.clientY - rect.top) * scaleY;
    S.hoverWorld = screenToWorld(px, py);
    if (S.painting) { e.preventDefault(); paintAtWorld(S.hoverWorld.x, S.hoverWorld.y); }
  });
  canvas.addEventListener('pointerleave', () => { S.hoverWorld = null; });
  window.addEventListener('pointerup', () => {
    if (S.painting) { S.painting = false; flushSkinNow(); historyPush(); }
  });

  // ---------- Movement ----------
  function isTypingInField() {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingInField()) return; // never steal keystrokes from a text field
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) e.preventDefault();
    S.keys[k] = true;
  });
  window.addEventListener('keyup', (e) => {
    S.keys[e.key.toLowerCase()] = false;
  });

  function getMoveVector() {
    let dx = 0, dy = 0;
    if (S.keys['arrowup'] || S.keys['w']) dy -= 1;
    if (S.keys['arrowdown'] || S.keys['s']) dy += 1;
    if (S.keys['arrowleft'] || S.keys['a']) dx -= 1;
    if (S.keys['arrowright'] || S.keys['d']) dx += 1;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    return { dx, dy };
  }

  // ---------- HUD ----------
  function setBanner(text) {
    const el = $('banner');
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function updateHud() {
    $('game-code').textContent = S.code;
    $('game-phase').textContent = S.phase === 'hiding' ? 'Hiding' : S.phase === 'seeking' ? 'Seeking' : S.phase;
    const role = myRole();
    $('hud-role').textContent = role ? (role === 'seeker' ? 'You: Seeker 🔍' : 'You: Hider 🙈') : '';
    const hidersLeft = [...S.players.values()].filter(p => p.role === 'hider' && !p.tagged).length;
    $('game-remaining').textContent = hidersLeft;

    let remainMs = 0;
    if (S.phaseEnd) remainMs = Math.max(0, S.phaseEnd - Date.now());
    const secs = Math.ceil(remainMs / 1000);
    $('game-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    const cover = $('hiding-cover');
    const showCover = S.phase === 'hiding' && role === 'seeker';
    cover.classList.toggle('hidden', !showCover);
    if (showCover) $('hiding-cover-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    const strip = $('player-strip');
    strip.innerHTML = '';
    [...S.players.values()].forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'player-chip' + (p.tagged ? ' chip-tagged' : '');
      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = TEAM_COLORS[p.colorIndex];
      const roleIcon = document.createElement('span');
      roleIcon.className = 'chip-role';
      roleIcon.textContent = p.role === 'seeker' ? '🔍' : '🙈';
      const name = document.createElement('span');
      name.textContent = p.name;
      chip.append(dot, roleIcon, name);
      strip.appendChild(chip);
    });
  }

  // Tagging happens by walking into a hider — no click needed. We check
  // every frame while seeking and fire a `tag` message the moment our
  // circle overlaps theirs, throttled per-target so a lingering overlap
  // doesn't flood the server (the server itself also enforces a longer
  // cooldown per hit, plus a hit count before anyone is actually caught).
  function checkTouchTags(t) {
    if (S.phase !== 'seeking' || myRole() !== 'seeker') return;
    const me = S.players.get(S.playerId);
    if (!me || me.tagged || me.renderX == null || me.renderY == null) return;
    S.players.forEach(p => {
      if (p.id === S.playerId || p.role !== 'hider' || p.tagged || p.renderX == null || p.renderY == null) return;
      const d = Math.hypot(me.renderX - p.renderX, me.renderY - p.renderY);
      if (d > TOUCH_RADIUS) return;
      const last = S.tagAttempts.get(p.id) || 0;
      if (t - last < TAG_RESEND_MS) return;
      S.tagAttempts.set(p.id, t);
      send({ type: 'tag', targetId: p.id });
    });
  }

  // ---------- Game loop ----------
  let lastTime = 0, lastMoveSend = 0, wasMoving = false;
  function frame(t) {
    const dt = lastTime ? Math.min(0.05, (t - lastTime) / 1000) : 0;
    lastTime = t;

    const me = S.players.get(S.playerId);
    const role = myRole();
    const canMove = me && !me.tagged && !S.paintMode &&
      (S.phase === 'seeking' || (S.phase === 'hiding' && role === 'hider'));

    let moving = false;
    if (canMove) {
      const { dx, dy } = getMoveVector();
      moving = !!(dx || dy);
      if (moving) {
        const speedMult = (S.phase === 'seeking' && role === 'hider') ? 0.25 : 1;
        const speed = MOVE_SPEED * speedMult;
        me.renderX = Math.max(0.3, Math.min(COLS - 0.3, (me.renderX ?? me.x) + dx * speed * dt));
        me.renderY = Math.max(0.3, Math.min(ROWS - 0.3, (me.renderY ?? me.y) + dy * speed * dt));
        me.x = me.renderX; me.y = me.renderY;
        // While actively moving, a periodic update is enough — other
        // clients smooth between positions, so this doesn't need to be
        // frequent.
        if (t - lastMoveSend > 120) {
          lastMoveSend = t;
          send({ type: 'move', x: me.x, y: me.y });
        }
      }
    }
    // The moment movement stops, send the exact final position right away
    // instead of waiting for the next throttled tick. Otherwise the last
    // few pixels of motion between the previous send and the stop never
    // reach other clients, and that player stays visibly offset on their
    // screens until they move again.
    if (wasMoving && !moving && me) {
      lastMoveSend = t;
      send({ type: 'move', x: me.x, y: me.y });
    }
    wasMoving = moving;
    if (me) { me.renderX = me.renderX ?? me.x; me.renderY = me.renderY ?? me.y; }

    S.players.forEach(p => {
      if (p.id === S.playerId || p.x == null) return;
      p.renderX = p.renderX == null ? p.x : p.renderX + (p.x - p.renderX) * Math.min(1, dt * 8);
      p.renderY = p.renderY == null ? p.y : p.renderY + (p.y - p.renderY) * Math.min(1, dt * 8);
    });

    if (S.skinDirty && t - lastSkinSend > 180) flushSkinNow();

    checkTouchTags(t);
    draw(t, dt);
    updateHud();

    S.loopHandle = requestAnimationFrame(frame);
  }

  function startGameLoop() {
    if (S.loopHandle) return;
    lastTime = 0;
    S.loopHandle = requestAnimationFrame(frame);
  }
  function stopGameLoop() {
    if (S.loopHandle) cancelAnimationFrame(S.loopHandle);
    S.loopHandle = null;
  }

  // ---------- Results ----------
  function renderResults(hiders, seekers, outcome) {
    $('results-outcome').textContent = outcome === 'hiders'
      ? '🎨 The hiders win — camouflage held!'
      : '🔍 The seekers win — everyone was found!';

    const hWrap = $('results-hiders');
    hWrap.innerHTML = '';
    hiders.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'result-row' + (!p.tagged ? ' result-winner' : '');
      const rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = i + 1;
      const dot = document.createElement('span');
      dot.className = 'result-dot';
      dot.style.background = TEAM_COLORS[p.colorIndex];
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = p.name + (p.id === S.playerId ? ' (you)' : '');
      const tag = document.createElement('span');
      tag.className = 'result-tag';
      tag.textContent = p.tagged ? 'Caught' : 'Never found';
      row.append(rank, dot, name, tag);
      hWrap.appendChild(row);
    });

    const sWrap = $('results-seekers');
    sWrap.innerHTML = '';
    seekers.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = i + 1;
      const dot = document.createElement('span');
      dot.className = 'result-dot';
      dot.style.background = TEAM_COLORS[p.colorIndex];
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = p.name + (p.id === S.playerId ? ' (you)' : '');
      row.append(rank, dot, name);
      sWrap.appendChild(row);
    });

    $('btn-play-again').classList.toggle('hidden', S.hostId !== S.playerId);
  }
})();
