'use strict';

require('./safe-console');

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const BASE_PORT = Number(process.env.PORT) || 8080;
let PORT = BASE_PORT;
const PORT_TRIES = 20;
const UDP_PORT = Number(process.env.UDP_PORT) || 8082;
const ROOM = (process.env.ROOM || '8888').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || '8888';
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const OPEN_BROWSER = process.argv.includes('--open') || process.env.LANAUDIO_OPEN === '1';
const USE_TRAY = process.argv.includes('--tray') || process.env.LANAUDIO_TRAY === '1';
const DEBUG = process.env.LANAUDIO_DEBUG === '1';

/* ---------- persistent hotkey configuration ---------- */
const HOTKEY_FILE = process.env.LANAUDIO_HOTKEYS
  || path.join(process.env.APPDATA || os.homedir(), 'LAN Audio', 'hotkeys.json');

function defaultHotkeys() {
  return {
    version: 1,
    targets: {
      global: { label: '全局', hotkey: 'Alt+P', deviceId: '' },
      slot1: { label: '设备 1', hotkey: 'Alt+0', deviceId: '' },
      slot2: { label: '设备 2', hotkey: 'Alt+9', deviceId: '' },
    },
    actions: {
      toggleSend: { label: '发电脑 全部开/关', hotkey: '' },
      sendOn: { label: '发电脑：开（绝对）', hotkey: '' },
      sendOff: { label: '发电脑：关（绝对）', hotkey: '' },
      toggleReceive: { label: '收电脑 全部开/关', hotkey: '' },
      receiveOn: { label: '收电脑：开（绝对）', hotkey: '' },
      receiveOff: { label: '收电脑：关（绝对）', hotkey: '' },
      toggleMic: { label: '麦克风传输 全部开/关', hotkey: '' },
      cycleMode: { label: '音源循环', hotkey: '' },
      modeApp: { label: '音源：内部声音', hotkey: '' },
      modeMic: { label: '音源：麦克风', hotkey: '' },
      modeBoth: { label: '音源：内部 + 麦克风', hotkey: '' },
      togglePcMute: { label: '电脑静音 开/关', hotkey: '' },
      toggleMonitor: { label: '电脑麦克风本地监听 开/关', hotkey: '' },
    },
  };
}

function mergeHotkeys(raw) {
  const base = defaultHotkeys();
  if (!raw || typeof raw !== 'object') return base;
  for (const group of ['targets', 'actions']) {
    if (!raw[group] || typeof raw[group] !== 'object') continue;
    for (const key of Object.keys(base[group])) {
      const item = raw[group][key];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.hotkey === 'string') base[group][key].hotkey = item.hotkey.trim().slice(0, 64);
      if (typeof item.deviceId === 'string') base[group][key].deviceId = item.deviceId.slice(0, 128);
      if (typeof item.label === 'string') base[group][key].label = item.label.slice(0, 64);
    }
  }
  return base;
}

function loadHotkeys() {
  try {
    return mergeHotkeys(JSON.parse(fs.readFileSync(HOTKEY_FILE, 'utf8')));
  } catch {
    return defaultHotkeys();
  }
}

function saveHotkeys() {
  try {
    fs.mkdirSync(path.dirname(HOTKEY_FILE), { recursive: true });
    fs.writeFileSync(HOTKEY_FILE, JSON.stringify(hotkeys, null, 2), 'utf8');
  } catch (err) {
    console.error('[hotkeys] save failed:', err.message);
  }
}

let hotkeys = loadHotkeys();
let hotkeyStatus = { registered: [], errors: {} };

function isLocalRequest(req) {
  const addr = String(req.socket.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readJsonBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (err) {
      cb(err);
    }
  });
  req.on('error', (err) => cb(err));
}

/**
 * Packaged exe: open the browser automatically like a desktop app.
 * The notification-area icon is handled by the native launcher (LAN Audio.exe),
 * so the SEA build does not start the PowerShell helper itself.
 */
const IS_SEA = (() => {
  try { return require('node:sea').isSea(); } catch { return false; }
})();
const WANT_TRAY = USE_TRAY;
const WANT_OPEN = OPEN_BROWSER || (IS_SEA && !process.argv.includes('--no-open'));

// When packaged with Node SEA, the web files are embedded instead of on disk.
let EMBEDDED_ASSETS = null;
try {
  const sea = require('node:sea');
  if (sea.isSea && sea.isSea()) {
    EMBEDDED_ASSETS = sea.getAsset('web-assets', 'utf8');
    if (typeof EMBEDDED_ASSETS === 'string') EMBEDDED_ASSETS = JSON.parse(EMBEDDED_ASSETS);
    for (const key of Object.keys(EMBEDDED_ASSETS)) {
      const buf = Buffer.from(EMBEDDED_ASSETS[key].data, 'base64');
      EMBEDDED_ASSETS[key].data = buf;
      EMBEDDED_ASSETS[key].length = buf.length;
    }
  }
} catch { /* not running inside a SEA build */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function localIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push({ name, address: info.address, netmask: info.netmask });
      }
    }
  }
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (pathname === '/') pathname = '/index.html';

  if (EMBEDDED_ASSETS) {
    const asset = EMBEDDED_ASSETS[pathname];
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const isAsset = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': asset.mime || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-store',
      'Content-Length': asset.length,
    });
    return res.end(asset.data);
  }

  const full = path.resolve(WEB_ROOT, '.' + pathname);
  if (!full.startsWith(WEB_ROOT + path.sep) && full !== WEB_ROOT) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    const isAsset = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-store',
      'Content-Length': st.size,
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch { /* fall through to static handler */ }

  if (pathname === '/api/info' || req.url.startsWith('/api/info')) {
    return sendJson(res, 200, {
      service: 'lanaudio',
      room: ROOM,
      port: PORT,
      udpPort: UDP_PORT,
      addresses: localIPv4().map((x) => x.address),
      version: 2,
    });
  }

  if (pathname === '/api/hotkeys' && req.method === 'GET') {
    return sendJson(res, 200, {
      config: hotkeys,
      status: hotkeyStatus,
      activeTarget: getRoom(ROOM).activeTarget || 'global',
    });
  }

  if (pathname === '/api/hotkeys' && req.method === 'PUT') {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'local only' });
    return readJsonBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad json' });
      hotkeys = mergeHotkeys(body && body.config ? body.config : body);
      hotkeys.version = (hotkeys.version || 0) + 1;
      hotkeyStatus = { registered: [], errors: {} };
      saveHotkeys();
      notifyPc(getRoom(ROOM), { type: 'hotkeys', config: hotkeys, status: hotkeyStatus });
      return sendJson(res, 200, { ok: true, config: hotkeys });
    });
  }

  if (pathname === '/api/hotkeys/status' && req.method === 'POST') {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'local only' });
    return readJsonBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad json' });
      hotkeyStatus = {
        registered: Array.isArray(body.registered) ? body.registered.map(String).slice(0, 64) : [],
        errors: body.errors && typeof body.errors === 'object' ? body.errors : {},
      };
      notifyPc(getRoom(ROOM), { type: 'hotkey-status', status: hotkeyStatus });
      return sendJson(res, 200, { ok: true });
    });
  }

  if (pathname === '/api/hotkey' && req.method === 'POST') {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'local only' });
    return readJsonBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad json' });
      const result = executeHotkey(body || {}, req);
      return sendJson(res, result.ok ? 200 : 400, result);
    });
  }

  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });

/** roomCode -> { pc: WebSocket|null, phones: Map<clientId, WebSocket>, nextPhoneId: number } */
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { pcs: new Set(), phones: new Map(), nextPhoneId: 1, activeTarget: 'global', pcMuted: false };
    rooms.set(code, room);
  }
  return room;
}

function allocPhoneId(room) {
  let id = room.nextPhoneId || 1;
  let guard = 0;
  while (room.phones.has(String(id)) && guard++ < 255) {
    id = (id % 255) + 1;
  }
  room.nextPhoneId = (id % 255) + 1;
  return String(id);
}

function isOpen(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

function sendText(ws, payload) {
  if (!isOpen(ws)) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch { /* ignore */ }
}

function phoneList(room) {
  const list = [];
  for (const [id, ws] of room.phones) {
    if (isOpen(ws)) list.push({
      id,
      name: ws.clientName || 'Android',
      send: ws.sendEnabled !== false,
      receive: ws.receiveEnabled !== false,
      sendPeer: ws.sendPeerEnabled === true,
      receivePeer: ws.receivePeerEnabled === true,
      // 1.2+ sends microphone frames separately (frame type 2).
      micSplit: ws.micSplit === true,
      ver: ws.clientVer || '',
      deviceId: ws.deviceKey || '',
      mode: Number.isFinite(ws.sourceMode) ? ws.sourceMode : 0,
      drops: Number.isFinite(ws.clientDrops) ? ws.clientDrops : 0,
    });
  }
  return list;
}

function notifyPc(room, payload) {
  // More than one PC page may be open (several tabs / several computers).
  // Fan out instead of letting them replace each other.
  for (const ws of room.pcs) sendText(ws, payload);
}

function notifyPhone(room, id, payload) {
  sendText(room.phones.get(id), payload);
}

function broadcastPhones(room, payload) {
  for (const ws of room.phones.values()) sendText(ws, payload);
}

function announcePhones(room) {
  notifyPc(room, { type: 'phones', phones: phoneList(room) });
}

function dropPhone(room, id, reason) {
  const ws = room.phones.get(id);
  if (!ws) return;
  room.phones.delete(id);
  notifyPc(room, { type: 'phone-left', id, reason });
  announcePhones(room);
  broadcastPhones(room, { type: 'phones', phones: phoneList(room) });
  console.log(`[ws] phone ${id} left room ${room.code}${reason ? ` (${reason})` : ''}`);
}

/* ---------- PC → phone controls and global hotkeys ---------- */

function phoneByTarget(room, target) {
  if (target === 'global') return [...room.phones.values()].filter(isOpen);
  const slot = hotkeys.targets[target];
  if (!slot) return [];
  if (slot.deviceId) {
    return [...room.phones.values()].filter((p) => isOpen(p) && p.deviceKey === slot.deviceId);
  }
  return [];
}

function sendPhoneControl(room, target, control) {
  const phones = phoneByTarget(room, target);
  for (const phone of phones) {
    sendText(phone, { type: 'control', ...control });
  }
  return phones.length;
}

/** Give the first two phones a stable slot; the user can reassign later. */
function bindPhoneSlot(ws, room) {
  const key = ws.deviceKey;
  if (!key) return;
  const already = Object.values(hotkeys.targets).some((t) => t.deviceId === key);
  if (already) return;
  for (const name of ['slot1', 'slot2']) {
    const slot = hotkeys.targets[name];
    if (slot && !slot.deviceId) {
      slot.deviceId = key;
      saveHotkeys();
      notifyPc(room, { type: 'hotkeys', config: hotkeys, status: hotkeyStatus });
      return;
    }
  }
}

function executeHotkey(body, req) {
  const room = getRoom(String(body.room || ROOM).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || ROOM);
  const action = typeof body.action === 'string' ? body.action : '';
  let target = typeof body.target === 'string' ? body.target : '';

  if (target && hotkeys.targets[target] && !action) {
    room.activeTarget = target;
    notifyPc(room, { type: 'active-target', target });
    return { ok: true, activeTarget: target };
  }

  if (!target) target = room.activeTarget || 'global';
  if (!hotkeys.targets[target]) return { ok: false, error: 'unknown target' };
  if (!action || !hotkeys.actions[action]) {
    room.activeTarget = target;
    notifyPc(room, { type: 'active-target', target });
    return { ok: true, activeTarget: target };
  }

  if (action === 'togglePcMute') {
    room.pcMuted = !room.pcMuted;
    notifyPc(room, { type: 'pc-mute', muted: room.pcMuted });
    return { ok: true, muted: room.pcMuted };
  }
  if (action === 'toggleMonitor') {
    notifyPc(room, { type: 'pc-action', action: 'toggle-monitor' });
    return { ok: true };
  }

  const phones = phoneByTarget(room, target);
  if (!phones.length) {
    notifyPc(room, { type: 'hotkey-error', message: '当前控制目标没有连接的手机' });
    return { ok: false, error: 'target phone not connected' };
  }

  // Phone commands are absolute. For a multi-phone target the whole group is
  // evaluated first, then every phone receives the same desired state. This
  // avoids the old per-phone inversion where a mixed group simply swapped
  // states instead of following the command.
  const allSendOn = phones.every((phone) => phone.sendEnabled !== false);
  const allReceiveOn = phones.every((phone) => phone.receiveEnabled !== false);
  const allMicOn = phones.every((phone) => {
    const mode = Number.isFinite(phone.sourceMode) ? phone.sourceMode : 0;
    return mode === 1 || mode === 2;
  });
  const sendTarget = !allSendOn;
  const receiveTarget = !allReceiveOn;
  const micSourceTarget = allMicOn ? 0 : 2;

  let sent = 0;
  for (const phone of phones) {
    let control = null;
    if (action === 'toggleSend') {
      control = { action: 'set-send', on: sendTarget };
    } else if (action === 'sendOn') {
      control = { action: 'set-send', on: true };
    } else if (action === 'sendOff') {
      control = { action: 'set-send', on: false };
    } else if (action === 'toggleReceive') {
      control = { action: 'set-receive', on: receiveTarget };
    } else if (action === 'receiveOn') {
      control = { action: 'set-receive', on: true };
    } else if (action === 'receiveOff') {
      control = { action: 'set-receive', on: false };
    } else if (action === 'toggleMic') {
      control = { action: 'set-mode', source: micSourceTarget };
    } else if (action === 'cycleMode') {
      const mode = Number.isFinite(phone.sourceMode) ? phone.sourceMode : 0;
      control = { action: 'set-mode', source: (mode + 1) % 3 };
    } else if (action === 'modeApp') {
      control = { action: 'set-mode', source: 0 };
    } else if (action === 'modeMic') {
      control = { action: 'set-mode', source: 1 };
    } else if (action === 'modeBoth') {
      control = { action: 'set-mode', source: 2 };
    }
    if (control) {
      sendText(phone, { type: 'control', ...control });
      sent++;
    }
  }
  return { ok: sent > 0, target, action, sent };
}

wss.on('connection', (ws, req) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return ws.close(1008, 'bad url');
  }

  const code = (url.searchParams.get('room') || ROOM).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || ROOM;
  const role = url.searchParams.get('role') === 'phone' ? 'phone' : 'pc';
  const room = getRoom(code);
  room.code = code;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'pc') {
    room.pcs.add(ws);
    ws.clientId = 'pc';
    sendText(ws, {
      type: 'welcome',
      role,
      room: code,
      peer: phoneList(room).length > 0,
      phones: phoneList(room),
      udpPort: UDP_PORT,
      activeTarget: room.activeTarget || 'global',
      pcMuted: room.pcMuted === true,
      hotkeys,
    });
    broadcastPhones(room, { type: 'peer', connected: true, role });
    console.log(`[ws] pc joined room ${code}`);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Phones always receive a 1-byte source id (0 = PC) before the frame,
        // so the phone side never has to guess the framing.
        const out = Buffer.concat([Buffer.from([0]), data]);
        for (const target of room.phones.values()) {
          if (!isOpen(target)) continue;
          if (target.receiveEnabled === false) continue;
          if (target.bufferedAmount > 2 * 1024 * 1024) continue;
          try { target.send(out, { binary: true }); } catch { /* ignore */ }
        }
        return;
      }

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') {
        sendText(ws, { type: 'pong', t: msg.t });
        return;
      }
      if (msg.type === 'hello') {
        broadcastPhones(room, { type: 'peer-info', role, info: msg.info || {} });
        return;
      }
      if (msg.type === 'to-phone' && msg.id) {
        sendText(room.phones.get(String(msg.id)), msg.payload || msg);
        return;
      }
      if (msg.type === 'control' && msg.id) {
        sendText(room.phones.get(String(msg.id)), {
          type: 'control',
          action: String(msg.action || ''),
          source: msg.source,
          on: msg.on,
        });
        return;
      }
      if (msg.type === 'kick' && msg.id) {
        const id = String(msg.id);
        const target = room.phones.get(id);
        try { target?.close(4002, 'kicked'); } catch { /* ignore */ }
        dropPhone(room, id, 'kicked by pc');
        return;
      }
      if (msg.type === 'phones?') {
        announcePhones(room);
        return;
      }
    });

    ws.on('close', () => {
      if (!room.pcs.delete(ws)) return;
      if (room.pcs.size === 0) {
        broadcastPhones(room, { type: 'peer', connected: false, role });
      }
      if (room.pcs.size === 0 && room.phones.size === 0) rooms.delete(code);
      console.log(`[ws] pc left room ${code} (${room.pcs.size} left)`);
    });
    ws.on('error', () => { /* close handler cleans up */ });
    return;
  }

  /* ---------- phone connection ---------- */
  const id = allocPhoneId(room);
  ws.clientId = id;
  ws.clientName = 'Android';
  ws.sendEnabled = true;
  ws.receiveEnabled = true;
  room.phones.set(id, ws);

  sendText(ws, {
    type: 'welcome',
    role,
    id,
    room: code,
    peer: room.pcs.size > 0,
    phones: phoneList(room).filter((p) => p.id !== id),
    udpPort: UDP_PORT,
    activeTarget: room.activeTarget || 'global',
  });
  notifyPc(room, { type: 'phone-joined', id, name: ws.clientName });
  announcePhones(room);
  // Tell existing phones about the newcomer, and give the newcomer the list.
  broadcastPhones(room, { type: 'phones', phones: phoneList(room) });
  broadcastPhones(room, { type: 'peer', connected: true, role, id });
  console.log(`[ws] phone ${id} joined room ${code}`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (DEBUG) {
        ws._rxCount = (ws._rxCount || 0) + 1;
        if (ws._rxCount === 1 || ws._rxCount % 100 === 0) {
          console.log(`[debug] phone ${id} rx frames=${ws._rxCount} len=${data.length} target=${data[0]}`);
        }
      }
      // First byte: target. 0 = the PC, 1..255 = another phone's client id.
      // Strip it before relaying; every receiver gets a source id prepended.
      const target = data.length > 1 ? data[0] : 0;
      const body = data.subarray(1);
      if (target === 0) {
        const out = Buffer.concat([Buffer.from([Number(id)]), body]);
        for (const pc of room.pcs) {
          if (!isOpen(pc)) continue;
          if (pc.bufferedAmount > 8 * 1024 * 1024) continue;
          try { pc.send(out, { binary: true }); } catch { /* ignore */ }
        }
        return;
      }
      const targetId = String(target);
      if (targetId === id) return;
      const peer = room.phones.get(targetId);
      if (!isOpen(peer)) return;
      if (peer.receivePeerEnabled === false) return;
      if (peer.bufferedAmount > 2 * 1024 * 1024) return;
      const out = Buffer.concat([Buffer.from([Number(id)]), body]);
      try { peer.send(out, { binary: true }); } catch { /* ignore */ }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      sendText(ws, { type: 'pong', t: msg.t });
      return;
    }
    if (msg.type === 'hello') {
      ws.clientName = String((msg.info && msg.info.name) || 'Android').slice(0, 32);
      if (typeof msg.info?.send === 'boolean') ws.sendEnabled = msg.info.send;
      if (typeof msg.info?.receive === 'boolean') ws.receiveEnabled = msg.info.receive;
      if (typeof msg.info?.sendPeer === 'boolean') ws.sendPeerEnabled = msg.info.sendPeer;
      if (typeof msg.info?.receivePeer === 'boolean') ws.receivePeerEnabled = msg.info.receivePeer;
      if (typeof msg.info?.micSplit === 'boolean') ws.micSplit = msg.info.micSplit;
      if (msg.info?.ver != null) ws.clientVer = String(msg.info.ver).slice(0, 16);
      if (msg.info?.deviceId != null) ws.deviceKey = String(msg.info.deviceId).slice(0, 128);
      if (Number.isFinite(msg.info?.mode)) ws.sourceMode = Math.max(0, Math.min(2, Number(msg.info.mode)));
      if (Number.isFinite(msg.info?.drops)) ws.clientDrops = Number(msg.info.drops);
      bindPhoneSlot(ws, room);
      const info = {
        ...(msg.info || {}),
        name: ws.clientName,
        id,
        micSplit: ws.micSplit === true,
        deviceId: ws.deviceKey || '',
        mode: Number.isFinite(ws.sourceMode) ? ws.sourceMode : 0,
      };
      notifyPc(room, { type: 'phone-info', id, info });
      announcePhones(room);
      broadcastPhones(room, { type: 'phone-info', id, info });
      return;
    }
    if (msg.type === 'phones?') {
      sendText(ws, { type: 'phones', phones: phoneList(room).filter((p) => p.id !== id) });
      return;
    }
    notifyPc(room, { type: 'from-phone', id, payload: msg });
  });

  ws.on('close', () => {
    if (room.phones.get(id) !== ws) return;
    dropPhone(room, id, '');
    broadcastPhones(room, { type: 'peer', connected: false, role, id });
    if (room.pcs.size === 0 && room.phones.size === 0) rooms.delete(code);
  });

  ws.on('error', () => { /* close handler cleans up */ });
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch { /* ignore */ }

  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

/* ---------- UDP discovery ---------- */

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udp.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8').trim();
  if (text !== 'LANAUDIO_DISCOVER') return;
  const reply = Buffer.from(JSON.stringify({
    service: 'lanaudio',
    port: PORT,
    room: ROOM,
    name: os.hostname(),
  }));
  udp.send(reply, rinfo.port, rinfo.address, () => { /* ignore */ });
});

udp.on('error', (err) => {
  console.error('[udp] error:', err.message);
});

function startUdpDiscovery() {
  udp.bind(UDP_PORT, '0.0.0.0', () => {
    console.log(`[udp] discovery listening on ${UDP_PORT}`);
  });
}

function startListening() {
  let attempt = 0;

  const tryPort = () => {
    const port = BASE_PORT + attempt;
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < PORT_TRIES) {
        attempt++;
        console.log(`[port] ${port} 被占用，尝试 ${BASE_PORT + attempt}`);
        setImmediate(tryPort);
        return;
      }
      console.error(`[port] 无法监听端口：${err.message}`);
      process.exit(1);
    });

    server.listen(port, '0.0.0.0', () => {
      server.removeAllListeners('error');
      server.on('error', (err) => console.error('[server]', err.message));
      if (attempt > 0) {
        console.log(`[port] 已改用端口 ${port}`);
      }
      onListening();
    });
  };

  tryPort();
}

function onListening() {
  const ips = localIPv4();
  const port = server.address().port;
  PORT = port;
  console.log('');
  console.log('  LAN Audio 已启动');
  console.log('  ------------------------------');
  console.log(`  房间码: ${ROOM}`);
  console.log(`  电脑页面: http://localhost:${port}/`);
  for (const ip of ips) {
    console.log(`  手机连接: ws://${ip.address}:${port}  (房间 ${ROOM})`);
  }
  console.log(`  自动发现 UDP: ${UDP_PORT}`);
  if (port !== BASE_PORT) {
    console.log(`  提示: ${BASE_PORT} 被占用，本次使用 ${port}`);
  }
  console.log('  ------------------------------');
  console.log('');

  if (WANT_OPEN) openBrowser(port);
  if (WANT_TRAY) installTray(port);
}

function openBrowser(port) {
  const url = `http://localhost:${port}/`;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* opening the browser is best-effort */ }
}

/** Launches the PowerShell notification-area helper shipped next to the exe. */
function installTray(port) {
  if (process.platform !== 'win32') return;

  const dir = path.dirname(process.execPath);
  const iconPath = process.env.LANAUDIO_ICON || path.join(dir, 'lanaudio.ico');
  const trayScript = process.env.LANAUDIO_TRAY_SCRIPT || path.join(dir, 'lanaudio-tray.ps1');

  if (!fs.existsSync(trayScript)) {
    console.error('[tray] missing helper script:', trayScript);
    return;
  }

  try {
    // Launch through cmd.exe `/c start` + hidden window style: a plain
    // detached spawn sometimes inherits a dead console and exits immediately.
    if (process.platform === 'win32') {
      const cmd = [
        'start', '""', '/b',
        'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden', '-File', `"${trayScript}"`,
      ].join(' ');
      const child = spawn('cmd.exe', ['/c', cmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          LANAUDIO_TRAY_ICON: iconPath,
          LANAUDIO_TRAY_URL: `http://localhost:${port}/`,
        },
      });
      child.unref();
    } else {
      return;
    }
    console.log('[tray] notification area icon started');
  } catch (e) {
    console.error('[tray] failed to start helper:', e.message);
  }
}

/* ---------- single instance guard ---------- */
// Only one backend may serve at a time. A second copy would silently move to
// the next port (8081, 8082, …), so phones and the PC page could end up on
// different servers. A named pipe acts as a cross-process lock on Windows.
const net = require('net');
const INSTANCE_PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\lanaudio-singleton'
  : path.join(os.tmpdir(), 'lanaudio.singleton.sock');
let _instanceLock = null;

function acquireSingleInstance(next) {
  const lock = net.createServer((sock) => {
    try { sock.end(JSON.stringify({ service: 'lanaudio', port: PORT, room: ROOM })); } catch { /* ignore */ }
  });
  lock.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[single-instance] LAN Audio 已经在运行，本次启动退出。');
      process.exit(0);
    }
    console.error('[single-instance] 锁创建失败：', err.message);
    next();
  });
  lock.listen(INSTANCE_PIPE, () => {
    _instanceLock = lock;
    try { lock.unref(); } catch { /* ignore */ }
    next();
  });
}

acquireSingleInstance(() => {
  startUdpDiscovery();
  startListening();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { udp.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}
