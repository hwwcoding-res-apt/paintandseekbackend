const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAPS_DIR = path.join(__dirname, 'public', 'maps');
const MAP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function listMapFiles() {
  try {
    return fs.readdirSync(MAPS_DIR)
      .filter(f => MAP_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/maps', (req, res) => res.json({ maps: listMapFiles() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Constants shared with client (kept in sync manually with public/game.js) ----
const PALETTE = [
  '#F2ECD9', '#D8CBA8', '#8B5E3C', '#4A2E20',
  '#5C7A4A', '#7FA05C', '#2F6E68', '#4E9E96',
  '#6B3F69', '#9B7BA8', '#E3A93B', '#F0D27A',
  '#C1554D', '#E08F86', '#232946', '#5B6478'
];
const TEAM_COLORS = ['#6B3F69', '#5C7A4A', '#E3A93B', '#2F6E68'];
const COLS = 22, ROWS = 22; // bigger than a player's viewport
const HIDE_MS = 60000;
const SEEK_MS = 120000;
const MAX_PLAYERS = 4;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TAG_RADIUS = 2; // in cell units — generous, since client/server positions can drift slightly between move updates
const HITS_TO_CATCH = 2; // a seeker has to tag a hider this many times to catch them
const TAG_COOLDOWN_MS = 2000; // minimum time between hits landing on the same hider
const HIDER_SEEK_SPEED_MULT = 0.25; // hiders move at this fraction of normal speed once seeking starts
const SKIN_SIZE = 32; // 32x32 paintable pixels per character

const rooms = new Map(); // code -> room

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeSkin(hex) {
  return new Array(SKIN_SIZE * SKIN_SIZE).fill(hex);
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, colorIndex: p.colorIndex, role: p.role,
    x: p.x, y: p.y, skin: p.skin,
    tagged: p.tagged, tagTime: p.tagTime, connected: p.connected,
    hitCount: p.hitCount || 0
  };
}

function publicPlayers(room) {
  return room.order.filter(id => room.players.has(id)).map(id => publicPlayer(room.players.get(id)));
}

// While hiders are hiding, seekers must not see where they are or what
// they're painting — that's the whole game. Strip that data out for them.
function stripHidersForSeeker(players) {
  return players.map(p => (p.role === 'hider' ? { ...p, x: null, y: null, skin: null } : p));
}

// A hider's hit count is only ever meaningful to that hider — showing it
// to anyone else (especially the seeker who landed the hit) would give
// away information the game is designed to keep hidden.
function hideHitCountsExcept(players, viewerId) {
  return players.map(p => (p.id === viewerId ? p : { ...p, hitCount: 0 }));
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, excludeId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== excludeId && p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

// Same as broadcast, but only to players matching `predicate` — used to
// keep hider movement/painting invisible to seekers during hiding.
function broadcastFiltered(room, obj, predicate, excludeId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id === excludeId) continue;
    if (!predicate(p)) continue;
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

// Sends each player a room_update honoring the hiding-phase fairness rule.
function broadcastPlayers(room, extra) {
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const players = (room.phase === 'hiding' && p.role === 'seeker')
      ? stripHidersForSeeker(publicPlayers(room))
      : publicPlayers(room);
    send(p.ws, Object.assign({ type: 'room_update', players: hideHitCountsExcept(players, p.id), hostId: room.hostId }, extra || {}));
  }
}

function clearPhaseTimer(room) {
  if (room.phaseTimeout) { clearTimeout(room.phaseTimeout); room.phaseTimeout = null; }
}

function activeHiderCount(room) {
  return [...room.players.values()].filter(p => p.role === 'hider' && !p.tagged).length;
}

// Roles are no longer picked by players — one random player becomes the
// seeker, everyone else hides, chosen fresh each time the game starts.
function assignRolesAutomatically(room) {
  const list = room.order.map(id => room.players.get(id)).filter(Boolean);
  const seekerIdx = Math.floor(Math.random() * list.length);
  list.forEach((p, i) => { p.role = (i === seekerIdx) ? 'seeker' : 'hider'; });
}

function startHiding(room) {
  clearPhaseTimer(room);
  // Client loads the host-selected map image (falls back to the first
  // available map, or a plain placeholder if none are uploaded).
  const availableMaps = listMapFiles();
  const mapFile = (room.mapFile && availableMaps.includes(room.mapFile))
    ? room.mapFile
    : (availableMaps[0] || null);
  room.map = {
    type: 'image',
    cols: COLS, rows: ROWS,
    file: mapFile
  };
  room.phase = 'hiding';

  const hiders = room.order.map(id => room.players.get(id)).filter(p => p && p.role === 'hider');
  const seekers = room.order.map(id => room.players.get(id)).filter(p => p && p.role === 'seeker');

  hiders.forEach(p => {
    p.tagged = false;
    p.tagTime = null;
    p.hitCount = 0;
    p.lastHitTime = null;
    p.skin = makeSkin(TEAM_COLORS[p.colorIndex % TEAM_COLORS.length]);
    p.x = 2 + Math.random() * (COLS - 4);
    p.y = 2 + Math.random() * (ROWS - 4);
  });
  seekers.forEach((p, i) => {
    p.tagged = false;
    p.tagTime = null;
    p.hitCount = 0;
    p.lastHitTime = null;
    p.skin = makeSkin(TEAM_COLORS[p.colorIndex % TEAM_COLORS.length]);
    const angle = (i / Math.max(1, seekers.length)) * Math.PI * 2;
    p.x = COLS / 2 + Math.cos(angle) * 1.4;
    p.y = ROWS / 2 + Math.sin(angle) * 1.4;
  });

  room.phaseEnd = Date.now() + HIDE_MS;
  // Seekers get a snapshot with hiders blanked out; hiders see everything.
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const players = p.role === 'seeker' ? stripHidersForSeeker(publicPlayers(room)) : publicPlayers(room);
    send(p.ws, { type: 'phase_change', phase: 'hiding', map: room.map, players, phaseEnd: room.phaseEnd });
  }
  room.phaseTimeout = setTimeout(() => startSeeking(room), HIDE_MS);
}

function startSeeking(room) {
  clearPhaseTimer(room);
  room.phase = 'seeking';
  room.phaseEnd = Date.now() + SEEK_MS;
  // Full reveal: everyone gets everyone's real position/skin now — but
  // each hider's hit count still only goes to that hider.
  const players = publicPlayers(room);
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    send(p.ws, { type: 'phase_change', phase: 'seeking', players: hideHitCountsExcept(players, p.id), phaseEnd: room.phaseEnd });
  }
  room.phaseTimeout = setTimeout(() => endGame(room), SEEK_MS);
}

function endGame(room) {
  clearPhaseTimer(room);
  room.phase = 'results';
  const all = [...room.players.values()];
  const hiders = all.filter(p => p.role === 'hider').sort((a, b) => {
    if (a.tagged !== b.tagged) return a.tagged ? 1 : -1;
    return (b.tagTime || 0) - (a.tagTime || 0);
  }).map(publicPlayer);
  const seekers = all.filter(p => p.role === 'seeker').map(publicPlayer);
  const outcome = hiders.some(h => !h.tagged) ? 'hiders' : 'seekers';
  broadcast(room, { type: 'phase_change', phase: 'results', hiders, seekers, outcome });
}

function backToLobby(room) {
  clearPhaseTimer(room);
  room.phase = 'lobby';
  room.map = null;
  room.phaseEnd = null;
  for (const p of room.players.values()) {
    p.tagged = false; p.tagTime = null;
    p.hitCount = 0; p.lastHitTime = null;
    p.skin = makeSkin(TEAM_COLORS[p.colorIndex % TEAM_COLORS.length]);
  }
  broadcast(room, { type: 'phase_change', phase: 'lobby', players: publicPlayers(room), hostId: room.hostId, maps: listMapFiles(), mapFile: room.mapFile });
}

function maybeEndByNoHidersLeft(room) {
  if (room.phase === 'seeking' && activeHiderCount(room) === 0) endGame(room);
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  room.players.delete(id);
  room.order = room.order.filter(x => x !== id);
  if (room.hostId === id) {
    room.hostId = room.order[0] || null;
  }
  if (room.players.size === 0) {
    clearPhaseTimer(room);
    setTimeout(() => {
      if (rooms.get(room.code) === room && room.players.size === 0) rooms.delete(room.code);
    }, 5 * 60 * 1000);
    return;
  }
  broadcastPlayers(room);
  maybeEndByNoHidersLeft(room);
}

wss.on('connection', (ws) => {
  let roomCode = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const name = String(msg.name || 'Painter').slice(0, 16).trim() || 'Painter';
      const code = makeCode();
      playerId = crypto.randomBytes(6).toString('hex');
      const player = {
        id: playerId, ws, name, colorIndex: 0, role: 'hider',
        x: COLS / 2, y: ROWS / 2, skin: makeSkin(TEAM_COLORS[0]),
        tagged: false, tagTime: null, hitCount: 0, lastHitTime: null, connected: true
      };
      const room = {
        code, hostId: playerId, phase: 'lobby',
        players: new Map([[playerId, player]]), order: [playerId],
        map: null, mapFile: null, phaseEnd: null, phaseTimeout: null
      };
      rooms.set(code, room);
      roomCode = code;
      send(ws, { type: 'created', code, playerId, hostId: room.hostId, players: publicPlayers(room), palette: PALETTE, teamColors: TEAM_COLORS, maps: listMapFiles(), mapFile: room.mapFile });
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', message: `No room found with code ${code}.` }); return; }
      if (room.players.size >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'That room is full (4 players max).' }); return; }
      if (room.phase !== 'lobby') { send(ws, { type: 'error', message: 'That game has already started. Ask the host for a new room.' }); return; }
      const name = String(msg.name || 'Painter').slice(0, 16).trim() || 'Painter';
      playerId = crypto.randomBytes(6).toString('hex');
      const colorIndex = room.order.length % TEAM_COLORS.length;
      const player = {
        id: playerId, ws, name, colorIndex, role: 'hider',
        x: COLS / 2, y: ROWS / 2, skin: makeSkin(TEAM_COLORS[colorIndex]),
        tagged: false, tagTime: null, hitCount: 0, lastHitTime: null, connected: true
      };
      room.players.set(playerId, player);
      room.order.push(playerId);
      roomCode = code;
      send(ws, { type: 'joined', code, playerId, hostId: room.hostId, players: publicPlayers(room), phase: room.phase, palette: PALETTE, teamColors: TEAM_COLORS, maps: listMapFiles(), mapFile: room.mapFile });
      broadcastPlayers(room);
      return;
    }

    const room = rooms.get(roomCode);
    if (!room || !playerId || !room.players.has(playerId)) return;
    const me = room.players.get(playerId);

    switch (msg.type) {
      case 'set_map': {
        if (room.hostId !== playerId) return;
        if (room.phase !== 'lobby') return;
        const file = String(msg.file || '');
        const available = listMapFiles();
        if (file && !available.includes(file)) return;
        room.mapFile = file || null;
        broadcast(room, { type: 'map_selected', mapFile: room.mapFile });
        break;
      }
      case 'start': {
        if (room.hostId !== playerId) return;
        if (room.phase !== 'lobby') return;
        if (room.players.size < 2) { send(ws, { type: 'error', message: 'Need at least 2 players to start.' }); return; }
        assignRolesAutomatically(room);
        startHiding(room);
        break;
      }
      case 'move': {
        if (room.phase !== 'hiding' && room.phase !== 'seeking') return;
        if (room.phase === 'hiding' && me.role === 'seeker') return; // seekers are frozen while hiders hide
        const x = Number(msg.x), y = Number(msg.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          me.x = Math.max(0.3, Math.min(COLS - 0.3, x));
          me.y = Math.max(0.3, Math.min(ROWS - 0.3, y));
          if (room.phase === 'hiding') {
            broadcastFiltered(room, { type: 'player_moved', id: playerId, x: me.x, y: me.y }, p => p.role === 'hider', playerId);
          } else {
            broadcast(room, { type: 'player_moved', id: playerId, x: me.x, y: me.y }, playerId);
          }
        }
        break;
      }
      case 'paint_skin': {
        if (me.role !== 'hider') return;
        const skin = msg.skin;
        const hexRe = /^#[0-9a-fA-F]{6}$/;
        if (Array.isArray(skin) && skin.length === SKIN_SIZE * SKIN_SIZE && skin.every(h => typeof h === 'string' && hexRe.test(h))) {
          me.skin = skin;
          if (room.phase === 'hiding') {
            broadcastFiltered(room, { type: 'player_skin', id: playerId, skin: me.skin }, p => p.role === 'hider', playerId);
          } else {
            broadcast(room, { type: 'player_skin', id: playerId, skin: me.skin }, playerId);
          }
        }
        break;
      }
      case 'tag': {
        if (room.phase !== 'seeking') return;
        if (me.role !== 'seeker') return;
        const target = room.players.get(msg.targetId);
        if (!target || target.role !== 'hider' || target.tagged) return;
        const dx = target.x - me.x, dy = target.y - me.y;
        if (Math.hypot(dx, dy) > TAG_RADIUS) return;
        // Cooldown so one lingering touch doesn't rack up multiple hits —
        // the seeker has to actually tap again, ideally after some
        // separation, to land the second hit.
        const now = Date.now();
        if (target.lastHitTime && now - target.lastHitTime < TAG_COOLDOWN_MS) return;
        target.lastHitTime = now;
        target.hitCount = (target.hitCount || 0) + 1;
        if (target.hitCount >= HITS_TO_CATCH) {
          target.tagged = true;
          target.tagTime = now;
          broadcast(room, { type: 'player_tagged', id: target.id, byId: me.id, tagTime: target.tagTime });
          maybeEndByNoHidersLeft(room);
        } else {
          send(target.ws, { type: 'player_hit', id: target.id, hitCount: target.hitCount });
        }
        break;
      }
      case 'play_again': {
        if (room.hostId !== playerId) return;
        if (room.phase !== 'results') return;
        backToLobby(room);
        break;
      }
      case 'leave': {
        removePlayer(room, playerId);
        roomCode = null; playerId = null;
        try { ws.close(); } catch {}
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(roomCode);
    if (room && playerId) removePlayer(room, playerId);
  });
});

server.listen(PORT, () => {
  console.log(`Paint & Seek listening on :${PORT}`);
});
