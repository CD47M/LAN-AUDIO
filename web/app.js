'use strict';

const $ = (id) => document.getElementById(id);

const RATE_CODE = { 16000: 1, 24000: 2, 48000: 3 };
const CODE_RATE = { 1: 16000, 2: 24000, 3: 48000 };

const DEFAULTS = {
  sampleRate: 48000,
  channels: 2,
  sendGain: 1,
  bufferMs: 90,
  playVolume: 0.8,
  playEnabled: true,
  duplex: 'auto',
  echoCancellation: true,
  noiseSuppression: true,
  balanceBuffer: true,
  catchup: 25,
  monitorVolume: 0.7,
  monitorMuted: false,
  monitorNr: 40,
};

const settings = loadSettings();

let ctx = null;
let mixBus = null;
let sendGainNode = null;
let sendNode = null;
let playerNode = null;
let playGain = null;
let monitorNode = null;
let monitorGainNode = null;
let audioReady = false;
let audioStarting = null;

// 'mic' | 'display' -> { stream, src, sendGain, monitorGain, send, monitor }
// A microphone can be sent to phones and/or monitored locally at the same time.
const sources = new Map();
let lastDisplaySurface = null;

let ws = null;
let wsOpen = false;
let room = '----';
let reconnectTimer = null;
let pingTimer = null;
let reconnectDelay = 2000;
let peerConnected = false;
let globalBufferTimer = 0;

let upBytes = 0;
let downBytes = 0;
let upFrames = 0;
let downFrames = 0;
let rtt = null;
let bufMs = 0;
let underruns = 0;
let dropped = 0;
let sendPeak = 0;
let recvPeak = 0;
let displayPeak = 0;
let lastLoggedAudioError = 0;

let lastAudioAt = 0;
let playerPlaying = false;
let notPlayingSince = 0;
let lastRecvBadgeKey = '';
let hotkeyConfig = null;
let hotkeyStatus = { registered: [], errors: {} };
let activeTarget = 'global';

const isFirefox = /firefox/i.test(navigator.userAgent);
const isChromium = /chrome|chromium|edg\//i.test(navigator.userAgent);

/* ---------------- UI helpers ---------------- */

function log(text, cls = '') {
  const el = $('log');
  if (!el) return;
  const row = document.createElement('div');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  row.innerHTML = `<span class="t">[${time}]</span> <span class="${cls}"></span>`;
  row.lastChild.textContent = text;
  el.appendChild(row);
  while (el.children.length > 200) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function setBadge(el, text, cls = '') {
  el.textContent = text;
  el.className = 'badge' + (cls ? ' ' + cls : '');
}

function setDot(el, state) {
  el.className = 'dot' + (state ? ' ' + state : '');
}

function fmtDb(peak) {
  if (!peak || peak < 1e-5) return '-∞ dB';
  return (20 * Math.log10(Math.min(1, peak))).toFixed(1) + ' dB';
}

function setMeter(barEl, peakEl, peak) {
  const db = peak <= 1e-5 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60));
  barEl.style.width = (db * 100).toFixed(1) + '%';
  peakEl.textContent = fmtDb(peak);
}

/* Single source of truth for the receive badge.  Every event funnels here so
 * "等待连接 / 等待手机 / 等待音频 / 缓冲中 / 接收中" cannot fight each other. */
function renderRecvState() {
  const now = performance.now();
  let text = '等待连接';
  let cls = '';

  if (!wsOpen) {
    text = '等待连接';
  } else if (!peerConnected) {
    text = '等待手机';
    cls = 'warn';
  } else if (!lastAudioAt || now - lastAudioAt > 1500) {
    text = '等待音频';
  } else if (!playerNode) {
    text = '待启用输出';
    cls = 'warn';
  } else if (playerPlaying) {
    text = '接收中';
    cls = 'ok';
  } else if (notPlayingSince && now - notPlayingSince < 700) {
    // brief underrun: keep the last stable state instead of flashing
    text = '接收中';
    cls = 'ok';
  } else {
    text = '缓冲中';
    cls = 'warn';
  }

  const key = text + '|' + cls;
  if (key === lastRecvBadgeKey) return;
  lastRecvBadgeKey = key;
  setBadge($('recvBadge'), text, cls);
}

/* ---------------- settings ---------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem('lanaudio.settings');
    if (raw) {
      const saved = JSON.parse(raw);
      const merged = { ...DEFAULTS, ...saved };
      // migrate the old “sync microphone buffers” switch
      if (merged.balanceBuffer == null) merged.balanceBuffer = saved.syncMic !== false;
      merged.bufferMs = Math.max(20, Math.min(400, Number(merged.bufferMs) || 90));
      const monitorVolume = Number(merged.monitorVolume);
      merged.monitorVolume = Number.isFinite(monitorVolume)
        ? Math.max(0, Math.min(3, monitorVolume)) : 0.7;
      const monitorNr = Number(merged.monitorNr);
      merged.monitorNr = Number.isFinite(monitorNr)
        ? Math.max(0, Math.min(100, monitorNr)) : 40;
      return merged;
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function saveSettings() {
  try {
    localStorage.setItem('lanaudio.settings', JSON.stringify(settings));
  } catch { /* ignore */ }
}

function syncControls() {
  $('sampleRate').value = String(settings.sampleRate);
  $('channels').value = String(settings.channels);
  $('sendGain').value = String(Math.round(settings.sendGain * 100));
  $('sendGainVal').textContent = Math.round(settings.sendGain * 100) + '%';
  $('bufferMs').value = String(settings.bufferMs);
  $('bufferMsVal').textContent = settings.bufferMs + ' ms';
  $('playVolume').value = String(Math.round(settings.playVolume * 100));
  $('playVolumeVal').textContent = Math.round(settings.playVolume * 100) + '%';
  updatePlayToggleButton();
  $('monitorVolume').value = String(Math.round((settings.monitorVolume == null ? 0.7 : settings.monitorVolume) * 100));
  $('monitorVolumeVal').textContent = Math.round((settings.monitorVolume == null ? 0.7 : settings.monitorVolume) * 100) + '%';
  $('monitorNr').value = String(Math.round(settings.monitorNr == null ? 40 : settings.monitorNr));
  $('monitorNrVal').textContent = Math.round(settings.monitorNr == null ? 40 : settings.monitorNr) + '%';
  $('monitorMute').checked = !!settings.monitorMuted;
  $('duplex').value = settings.duplex;
  $('echoCancellation').checked = !!settings.echoCancellation;
  $('noiseSuppression').checked = !!settings.noiseSuppression;
  $('balanceBuffer').checked = settings.balanceBuffer !== false;
  updateFormatBadge();
}

function updateFormatBadge() {
  const khz = settings.sampleRate / 1000;
  const ch = settings.channels === 2 ? '立体声' : '单声道';
  setBadge($('fmtBadge'), `${khz} kHz · ${ch}`);
}

function bindControls() {
  $('sampleRate').addEventListener('change', (e) => {
    settings.sampleRate = Number(e.target.value);
    saveSettings();
    updateFormatBadge();
    log(`采样率切换为 ${settings.sampleRate} Hz`);
  });

  $('channels').addEventListener('change', (e) => {
    settings.channels = Number(e.target.value);
    saveSettings();
    updateFormatBadge();
    log(`声道切换为 ${settings.channels === 2 ? '立体声' : '单声道'}`);
  });

  $('sendGain').addEventListener('input', (e) => {
    settings.sendGain = Number(e.target.value) / 100;
    $('sendGainVal').textContent = e.target.value + '%';
    saveSettings();
  });

  $('bufferMs').addEventListener('input', (e) => {
    settings.bufferMs = Math.max(20, Math.min(400, Number(e.target.value) || 90));
    $('bufferMsVal').textContent = settings.bufferMs + ' ms';
    saveSettings();
    clearTimeout(globalBufferTimer);
    globalBufferTimer = setTimeout(() => applyGlobalBuffer(settings.bufferMs), 250);
  });

  $('bufferMs').addEventListener('change', () => {
    clearTimeout(globalBufferTimer);
    applyGlobalBuffer(settings.bufferMs);
  });

  $('playVolume').addEventListener('input', (e) => {
    settings.playVolume = Number(e.target.value) / 100;
    $('playVolumeVal').textContent = e.target.value + '%';
    saveSettings();
    // Dragging the volume is a user gesture: start the engine if needed so
    // the slider responds immediately.
    if (!playerNode) enableAudio().catch(() => {});
    updatePlaybackGain();
  });

  // Master play/pause button replaces the old checkbox.
  $('btnPlayToggle').addEventListener('click', () => {
    settings.playEnabled = !settings.playEnabled;
    saveSettings();
    updatePlayToggleButton();
    updatePlaybackGain();
    log(settings.playEnabled ? '已恢复播放手机声音' : '已暂停播放手机声音', settings.playEnabled ? '' : 'warn');
  });

  $('monitorVolume').addEventListener('input', (e) => {
    settings.monitorVolume = Number(e.target.value) / 100;
    $('monitorVolumeVal').textContent = e.target.value + '%';
    saveSettings();
    updateMonitorGain();
  });

  $('monitorNr').addEventListener('input', (e) => {
    settings.monitorNr = Number(e.target.value);
    $('monitorNrVal').textContent = e.target.value + '%';
    saveSettings();
    updateMonitorNr();
  });

  $('monitorMute').addEventListener('change', (e) => {
    settings.monitorMuted = e.target.checked;
    saveSettings();
    updateMonitorGain();
    refreshSourceUI();
  });

  // per-phone mute / volume changes are pushed to the mixer immediately
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.play) return;
    const row = t.closest('.phone-row');
    const id = row && row.dataset.id;
    const p = id && phones.get(id);
    if (!p || !p.els) return;
    p.mute = !p.els.play.checked;
    setPhoneGain(p);
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.vol) return;
    const row = t.closest('.phone-row');
    const id = row && row.dataset.id;
    const p = id && phones.get(id);
    if (!p || !p.els) return;
    p.volume = Number(p.els.vol.value) / 100;
    setPhoneGain(p);
  });

  $('duplex').addEventListener('change', (e) => {
    settings.duplex = e.target.value;
    saveSettings();
    updatePlaybackGain();
  });

  $('echoCancellation').addEventListener('change', (e) => {
    settings.echoCancellation = e.target.checked;
    saveSettings();
  });

  $('noiseSuppression').addEventListener('change', (e) => {
    settings.noiseSuppression = e.target.checked;
    saveSettings();
  });

  $('balanceBuffer').addEventListener('change', (e) => {
    settings.balanceBuffer = e.target.checked;
    saveSettings();
    if (playerNode) {
      playerNode.port.postMessage({ type: 'balance', enabled: settings.balanceBuffer });
    }
    log(settings.balanceBuffer ? '已开启平衡缓冲：多设备统一取最大目标' : '已关闭平衡缓冲：每台设备使用自己的缓冲');
  });

  $('btnMic').addEventListener('click', () => toggleMic());
  $('btnMonitor').addEventListener('click', () => toggleMonitor());
  $('btnSystem').addEventListener('click', () => toggleDisplay());
  $('btnStopSend').addEventListener('click', () => stopAllSources());
}

/* ---------------- audio graph ---------------- */

async function enableAudio(fromButton = false) {
  if (audioReady) {
    if (ctx.state === 'suspended') await ctx.resume();
    return;
  }
  if (audioStarting) return audioStarting;

  audioStarting = (async () => {
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('/pcm-worklet.js?v=16');

      mixBus = ctx.createGain();
      mixBus.channelCount = 2;
      mixBus.channelCountMode = 'explicit';
      mixBus.channelInterpretation = 'speakers';

      sendGainNode = ctx.createGain();
      sendGainNode.gain.value = 1;

      sendNode = new AudioWorkletNode(ctx, 'pcm-sender', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      sendNode.port.onmessage = (ev) => onSendFrame(ev.data);

      const silent = ctx.createGain();
      silent.gain.value = 0;
      mixBus.connect(sendGainNode).connect(sendNode).connect(silent).connect(ctx.destination);

      playerNode = new AudioWorkletNode(ctx, 'pcm-mixer', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      playerNode.port.onmessage = (ev) => onPlayerMessage(ev.data);
      playerNode.port.postMessage({ type: 'config', bufferMs: settings.bufferMs });
      playerNode.port.postMessage({ type: 'balance', enabled: settings.balanceBuffer !== false });
      // Phones usually connect before the user enables audio output: push
      // their saved per-device settings into the freshly created mixer.
      for (const p of phones.values()) setPhoneGain(p);

      playGain = ctx.createGain();
      playGain.gain.value = 0;
      playerNode.connect(playGain).connect(ctx.destination);

      // Local monitor chain: source gain (unity) -> NR/gate + soft limiter
      // -> monitor gain -> speakers.  The volume gain sits AFTER the worklet
      // so the gate thresholds always see the unscaled microphone signal.
      monitorGainNode = ctx.createGain();
      monitorGainNode.gain.value = settings.monitorMuted ? 0 : settings.monitorVolume;

      monitorNode = new AudioWorkletNode(ctx, 'pcm-monitor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      monitorNode.port.postMessage({ type: 'config', nr: settings.monitorNr });
      monitorNode.connect(monitorGainNode).connect(ctx.destination);

      audioReady = true;
      await ctx.resume();
      updatePlaybackGain();
      if (pageRole === 'secondary') silenceForSecondary();
      log(`音频引擎已启动（${ctx.sampleRate} Hz）`, 'ok');
    } catch (err) {
      log('音频引擎启动失败：' + (err && err.message ? err.message : err), 'err');
      audioStarting = null;
      throw err;
    }
  })();

  try {
    await audioStarting;
  } finally {
    audioStarting = null;
  }
}

/** Route one source to the send mix and/or the local monitor output. */
function applySourceRouting(item) {
  try { item.sendGain.disconnect(); } catch { /* ignore */ }
  try { item.monitorGain.disconnect(); } catch { /* ignore */ }
  if (item.send && mixBus) item.sendGain.connect(mixBus);
  if (item.monitor) {
    // Unity into the monitor worklet; loudness/mute is applied after it.
    item.monitorGain.gain.value = 1;
    item.monitorGain.connect(monitorNode || ctx.destination);
  }
}

async function addSource(key, stream, options = {}) {
  stopSource(key, false);

  const src = ctx.createMediaStreamSource(stream);
  const sendGain = ctx.createGain();
  const monitorGain = ctx.createGain();
  sendGain.gain.value = 1;
  monitorGain.gain.value = 1;
  src.connect(sendGain);
  src.connect(monitorGain);

  const item = {
    stream,
    src,
    sendGain,
    monitorGain,
    send: options.send !== false,
    monitor: options.monitor === true,
  };
  sources.set(key, item);
  applySourceRouting(item);

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (sources.get(key)?.stream === stream) {
        log(`${key === 'display' ? '系统声音' : '麦克风'}已停止`, 'warn');
        stopSource(key, true);
      }
    });
  }

  refreshSourceUI();
  return item;
}

function stopSource(key, updateUI = true) {
  const item = sources.get(key);
  if (!item) return;
  sources.delete(key);
  try { item.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { item.src.disconnect(); } catch { /* ignore */ }
  try { item.sendGain.disconnect(); } catch { /* ignore */ }
  try { item.monitorGain.disconnect(); } catch { /* ignore */ }
  if (key === 'display') lastDisplaySurface = null;
  if (updateUI) refreshSourceUI();
}

function stopAllSources() {
  for (const key of [...sources.keys()]) stopSource(key, false);
  lastDisplaySurface = null;
  refreshSourceUI();
  log('已停止发送与本地监听');
}

function hasSendSource() {
  for (const item of sources.values()) if (item.send) return true;
  return false;
}

function refreshSourceUI() {
  const display = sources.get('display');
  const mic = sources.get('mic');
  const hasDisplay = !!display;
  const micSending = !!(mic && mic.send);
  const monitoring = !!(mic && mic.monitor);
  const names = [];
  if (hasDisplay) names.push(lastDisplaySurface === 'browser' ? '标签页声音' : '系统声音');
  if (micSending) names.push('麦克风');

  $('btnStopSend').disabled = !hasSendSource();
  $('btnMic').classList.toggle('active', micSending);
  $('btnSystem').classList.toggle('active', hasDisplay);

  if (!names.length) {
    setBadge($('sendBadge'), '未发送');
    $('sourceInfo').textContent = '未选择音源';
  } else {
    setBadge($('sendBadge'), '发送中', 'ok');
    $('sourceInfo').textContent = '当前音源：' + names.join(' + ');
  }

  const monitorBadge = $('monitorBadge');
  if (monitorBadge) {
    if (!monitoring) setBadge(monitorBadge, '关闭');
    else if (settings.monitorMuted) setBadge(monitorBadge, '已静音', 'warn');
    else setBadge(monitorBadge, '监听中', 'ok');
  }
  const btnMonitor = $('btnMonitor');
  if (btnMonitor) {
    btnMonitor.classList.toggle('active', monitoring);
    btnMonitor.textContent = monitoring ? '关闭监听' : '开启监听';
  }
  const monitorInfo = $('monitorInfo');
  if (monitorInfo) {
    monitorInfo.textContent = monitoring
      ? (mic && mic.send ? '正在本地播放，同时发送给手机' : '仅在本机播放，不发送给手机')
      : '未开启';
  }
  updatePlaybackGain();
}

function updateMonitorGain() {
  if (monitorGainNode) {
    const gain = settings.monitorMuted ? 0 : settings.monitorVolume;
    monitorGainNode.gain.value = gain;
    if (monitorNode) {
      try { monitorNode.port.postMessage({ type: 'enable', on: gain > 0 }); } catch { /* ignore */ }
    }
  }
  const el = $('monitorVolumeVal');
  if (el) el.textContent = Math.round(settings.monitorVolume * 100) + '%';
}

function updateMonitorNr() {
  if (monitorNode) {
    try { monitorNode.port.postMessage({ type: 'config', nr: settings.monitorNr }); } catch { /* ignore */ }
  }
  const el = $('monitorNrVal');
  if (el) el.textContent = Math.round(settings.monitorNr) + '%';
}

/* ---------------- page exclusivity ---------------- */

// Only one browser page may play audio.  The server marks the first page as
// primary; any later page is told to stop and shows an overlay instead.
// 'primary' | 'secondary' | 'unknown'.  Until the server says otherwise the
// page is allowed to play, so a single page always works immediately.
let wasPrimary = false;
let pageRole = 'unknown';

function applyPageStatus(count, isPrimary) {
  window.__pcPages = count;
  const pill = $('pagePill');
  const text = $('pageText');
  const dot = $('pageDot');
  if (pill) {
    pill.classList.toggle('bad', count > 1);
    pill.classList.toggle('ok', count === 1);
  }
  if (text) text.textContent = `前端 ${count}`;
  if (dot) setDot(dot, count === 1 ? 'ok' : 'bad');

  const overlay = $('secondaryBanner');

  if (!isPrimary) {
    const becameSecondary = pageRole !== 'secondary';
    pageRole = 'secondary';
    wasPrimary = false;
    silenceForSecondary();
    if (overlay) {
      overlay.classList.remove('hidden');
      const msg = $('secondaryCount');
      if (msg) msg.textContent = `当前共有 ${count} 个前端连接。`;
    }
    document.body.classList.add('readonly-page');
    if (becameSecondary) log('本页面只读：已有另一个前端在控制声音', 'warn');
    return;
  }

  const becamePrimary = pageRole !== 'primary';
  pageRole = 'primary';
  wasPrimary = true;
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('readonly-page');
  if (becamePrimary) {
    // New page, or taking over after the previous primary closed.
    updatePlaybackGain();
  }
}

/** Mute the local mixer so a secondary page is completely silent. */
function silenceForSecondary() {
  try {
    if (playGain) playGain.gain.value = 0;
    if (monitorGainNode) monitorGainNode.gain.value = 0;
    if (playerNode) playerNode.port.postMessage({ type: 'flush' });
    if (ctx && ctx.state === 'running') {
      for (const item of sources.values()) {
        try { item.send = false; applySourceRouting(item); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function updatePlaybackGain() {
  if (!playGain) return;
  // Only silence when the server explicitly marked this page secondary.
  if (pageRole === 'secondary') return;
  const sysLoop = sources.has('display') && lastDisplaySurface !== 'browser';
  const autoMute = settings.duplex === 'auto' && sysLoop;
  let g = settings.playEnabled ? settings.playVolume : 0;
  if (autoMute) g = 0;
  playGain.gain.value = g;
  $('duplexWarn').classList.toggle('hidden', !autoMute);
  updatePlayToggleButton();
}

/** Master play/pause button reflecting playback state. */
function updatePlayToggleButton() {
  const btn = $('btnPlayToggle');
  if (!btn) return;
  const on = settings.playEnabled && settings.playVolume > 0;
  btn.textContent = settings.playEnabled ? (settings.playVolume > 0 ? '正在播放' : '已静音') : '已暂停';
  btn.classList.toggle('paused', !on);
  btn.classList.toggle('muted', settings.playEnabled && settings.playVolume <= 0);
  const state = $('audioEngineState');
  if (state) {
    state.textContent = !audioReady
      ? '音频引擎未启动（拖动音量会自动启动）'
      : `音频引擎运行中 · ${ctx ? ctx.sampleRate / 1000 : 48} kHz`;
  }
}

/* ---------------- capture ---------------- */

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: true,
      channelCount: 2,
      sampleRate: 48000,
    },
    video: false,
  });
}

async function toggleMic() {
  await enableAudio();
  const item = sources.get('mic');
  if (item && item.send) {
    item.send = false;
    applySourceRouting(item);
    if (!item.monitor) stopSource('mic');
    else refreshSourceUI();
    log('已停止把电脑麦克风发送给手机');
    return;
  }
  if (item) {
    item.send = true;
    applySourceRouting(item);
    refreshSourceUI();
    log('电脑麦克风已开始发送给手机', 'ok');
    return;
  }

  try {
    const stream = await getMicStream();
    await addSource('mic', stream, { send: true, monitor: false });
    log('电脑麦克风已开始采集并发送', 'ok');
  } catch (err) {
    log('麦克风打开失败：' + (err && err.name === 'NotAllowedError' ? '权限被拒绝' : (err.message || err)), 'err');
  }
}

async function toggleMonitor() {
  await enableAudio();
  const item = sources.get('mic');
  if (item && item.monitor) {
    item.monitor = false;
    applySourceRouting(item);
    if (!item.send) stopSource('mic');
    else refreshSourceUI();
    updateMonitorGain();
    log('已关闭电脑麦克风本地监听');
    return;
  }
  if (item) {
    item.monitor = true;
    applySourceRouting(item);
    refreshSourceUI();
    updateMonitorGain();
    log('电脑麦克风本地监听已开启（不会发送给手机）', 'ok');
    return;
  }

  try {
    const stream = await getMicStream();
    await addSource('mic', stream, { send: false, monitor: true });
    updateMonitorGain();
    log('电脑麦克风本地监听已开启（不会发送给手机）', 'ok');
  } catch (err) {
    log('麦克风打开失败：' + (err && err.name === 'NotAllowedError' ? '权限被拒绝' : (err.message || err)), 'err');
  }
}

async function toggleDisplay() {
  await enableAudio();

  if (sources.has('display')) {
    stopSource('display');
    log('系统声音已停止');
    return;
  }

  if (isFirefox) {
    log('Firefox 不支持从屏幕/标签页捕获音轨。请改用 Edge 或 Chrome 共享系统声音；Firefox 仍可接收手机声音。', 'err');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') log('已取消共享');
    else log('共享失败：' + (err.message || err), 'err');
    return;
  }

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    log(
      isChromium
        ? '没有拿到音轨。请重新共享：选择“整个屏幕”并勾选“共享系统音频”，或选择带声音的标签页。'
        : '当前浏览器未提供音轨。',
      'err'
    );
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const surface = videoTrack && videoTrack.getSettings ? videoTrack.getSettings().displaySurface : undefined;
  lastDisplaySurface = surface || 'monitor';

  await addSource('display', stream);
  log(
    `系统声音已开始采集（${lastDisplaySurface === 'browser' ? '标签页' : lastDisplaySurface === 'window' ? '窗口' : '整个屏幕'}）`,
    'ok'
  );
  if (settings.duplex === 'auto' && lastDisplaySurface !== 'browser') {
    log('检测到系统级共享，已自动静音本地播放以避免回环；戴耳机或改用标签页共享可开全双工。', 'warn');
  }
}

/* ---------------- sender / receiver ---------------- */

function onSendFrame({ l, r }) {
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    const p = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    if (p > peak) peak = p;
  }
  if (peak > sendPeak) sendPeak = peak;
  displayPeak = Math.max(displayPeak, peak);

  if (!hasSendSource()) return;
  if (!wsOpen || !ws) return;

  const rate = settings.sampleRate;
  const ratio = Math.round(48000 / rate);
  const outLen = Math.floor(l.length / ratio);
  const channels = settings.channels;
  const bytes = 4 + outLen * channels * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  dv.setUint8(0, 1);
  dv.setUint8(1, RATE_CODE[rate] || 3);
  dv.setUint8(2, channels);
  dv.setUint8(3, 0);

  let off = 4;
  const gain = settings.sendGain;

  for (let i = 0; i < outLen; i++) {
    let sl = 0;
    let sr = 0;
    if (ratio === 1) {
      sl = l[i];
      sr = r[i];
    } else {
      for (let k = 0; k < ratio; k++) {
        sl += l[i * ratio + k] || 0;
        sr += r[i * ratio + k] || 0;
      }
      sl /= ratio;
      sr /= ratio;
    }
    sl = clamp16(sl * gain);
    sr = clamp16(sr * gain);
    if (channels === 1) {
      dv.setInt16(off, clamp16(((sl + sr) / 2) / 32768), true);
      off += 2;
    } else {
      dv.setInt16(off, sl, true); off += 2;
      dv.setInt16(off, sr, true); off += 2;
    }
  }

  try {
    ws.send(ab);
    upBytes += ab.byteLength;
    upFrames++;
  } catch { /* ignore */ }
}

function clamp16(v) {
  if (v <= -1) return -32768;
  if (v >= 1) return 32767;
  return v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
}

function onBinary(data) {
  if (data.byteLength < 6) return;
  if (window.__audioFrameCount != null) window.__audioFrameCount++;
  const all = new Uint8Array(data);
  const id = String(all[0]);
  const f = all;
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const frameType = dv.getUint8(1);
  // 1 = app / system audio, 2 = microphone-only (sent by app 1.2+).
  if (frameType !== 1 && frameType !== 2) return;
  const isMic = frameType === 2;
  const rate = CODE_RATE[dv.getUint8(2)] || 48000;
  const channels = dv.getUint8(3) || 1;
  const pcmOffset = 5;

  // Count frames even when local playback is disabled.
  downBytes += f.byteLength - 1;
  downFrames++;
  lastAudioAt = performance.now();
  renderRecvState();

  if (!phones.has(id)) ensurePhone(id);
  touchPhoneAudio(id, rate, channels);
  if (!phoneStats.has(id)) {
    phoneStats.set(id, { rate, channels, frames: 0, bytes: 0, lastAt: 0, micFrames: 0, appFrames: 0 });
  }
  const st = phoneStats.get(id);
  st.frames++;
  st.bytes += f.byteLength - 1;
  st.lastAt = performance.now();
  if (isMic) st.micFrames = (st.micFrames || 0) + 1;
  else st.appFrames = (st.appFrames || 0) + 1;

  if (!playerNode) {
    const now = Date.now();
    if (now - lastLoggedAudioError > 5000) {
      lastLoggedAudioError = now;
      log('收到手机音频，但音频输出未启用。请点击“启用音频输出”。', 'warn');
    }
    return;
  }

  const item = phones.get(id);
  // main gain only; the worklet applies the microphone-only gain itself
  const gain = item && !item.mute ? item.volume : 0;
  const streamId = isMic ? id + '#mic' : id;

  // Frame layout (see WsClient.sendAudio): [0]=source [1]=frameType
  // [2]=rate [3]=channels [4]=reserved, then little-endian int16 samples.
  // Build a view directly on the received buffer.  The old code used a
  // transfer list, which failed silently in some browsers and left the mixer
  // with no samples at all.
  if (f.byteLength < pcmOffset + 2) return;

  let pcm;
  try {
    const start = f.byteOffset + pcmOffset;
    const bytes = (f.byteLength - pcmOffset) & ~1;
    if (start % 2 === 0) {
      pcm = new Int16Array(f.buffer, start, bytes >> 1);
    } else {
      const copy = f.slice(pcmOffset, pcmOffset + bytes);
      pcm = new Int16Array(copy.buffer, copy.byteOffset, bytes >> 1);
    }
  } catch (err) {
    if (window.__audioDebug) console.warn('pcm view failed', err);
    return;
  }

  try {
    // No transfer list: plain structured clone works everywhere.
    playerNode.port.postMessage({ id: streamId, pcm, rate, channels, gain });
    if (window.__audioPosted != null) window.__audioPosted++;
  } catch (err) {
    if (window.__audioDebug) console.warn('postMessage failed', err);
  }
}

function sendPhoneControl(p, action, extra = {}) {
  if (!ws || !wsOpen) {
    log('未连接，控制命令未发送', 'warn');
    return;
  }
  try {
    ws.send(JSON.stringify({ type: 'control', id: p.id, action, ...extra }));
  } catch {
    log('控制命令发送失败', 'err');
  }
}

function setPhoneGain(p) {
  if (!p) return;
  const g = p.mute ? 0 : (p.volume == null ? 1 : p.volume);
  // Save first: the slider must work even before the audio engine is enabled,
  // otherwise the value is silently thrown away and nothing happens later.
  saveDevice(p);
  if (!playerNode) return;
  playerNode.port.postMessage({
    type: 'set-phone',
    id: p.id,
    gain: g,
    micGain: p.micGain == null ? 1 : p.micGain,
    nr: p.nr == null ? 0 : p.nr,
    pan: p.pan || 0,
    bufferMs: p.bufferMs == null ? settings.bufferMs : p.bufferMs,
    catchup: p.catchup == null ? settings.catchup : p.catchup,
  });
}

/** Global buffer slider: applies the same target to every connected phone. */
function applyGlobalBuffer(ms) {
  const value = Math.max(20, Math.min(400, Math.round(ms / 5) * 5));
  settings.bufferMs = value;
  $('bufferMs').value = String(value);
  $('bufferMsVal').textContent = value + ' ms';
  saveSettings();
  if (playerNode) playerNode.port.postMessage({ type: 'config', bufferMs: value });
  for (const p of phones.values()) {
    p.bufferMs = value;
    syncPhoneControls(p);
    setPhoneGain(p);
  }
  log(`全局接收缓冲：${value} ms`);
}

/** Apply a phone's slider value; no-op when it did not change. */
function commitPhoneBuffer(p) {
  if (!p || !p.els) return;
  const value = Math.max(20, Math.min(400, Math.round((Number(p.els.buffer.value) || settings.bufferMs) / 5) * 5));
  p.els.buffer.value = String(value);
  p.els.bufferVal.textContent = value + ' ms';
  if (p.bufferMs === value) return;
  p.bufferMs = value;
  setPhoneGain(p);
  log(`${p.name} 接收缓冲：${value} ms`);
}

/** Same curve as the worklet: 0 -> 1.005x, 100 -> 1.15x. */
function catchupRate(v) {
  const level = Math.max(0, Math.min(100, Number(v) || 0));
  return 1.005 + 0.145 * (level / 100) * (level / 100);
}

function catchupText(v) {
  const level = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  return `${level} · ${catchupRate(level).toFixed(3)}x`;
}

/** Apply a phone's catch-up slider; no-op when it did not change. */
function commitPhoneCatchup(p) {
  if (!p || !p.els) return;
  const value = Math.max(0, Math.min(100, Math.round(Number(p.els.catchup.value) || 0)));
  p.els.catchup.value = String(value);
  p.els.catchupVal.textContent = catchupText(value);
  if (p.catchup === value) return;
  p.catchup = value;
  setPhoneGain(p);
  log(`${p.name} 缓冲追赶：${catchupText(value)}`);
}

function touchPhoneAudio(id, rate, channels) {
  const p = phones.get(id);
  if (!p || !p.els) return;
  p.els.dot.className = 'dot ok';
  if (!p.els.rate.textContent || p.els.rate.textContent === '无音频') {
    p.els.rate.textContent = `${rate / 1000} kHz · ${channels === 2 ? '立体声' : '单声道'}`;
  }
}

function phoneIdOfStream(streamId) {
  const s = String(streamId);
  return s.endsWith('#mic') ? s.slice(0, -4) : s;
}

function renderPhoneMeters(list) {
  const agg = new Map();
  for (const item of list || []) {
    if (item.id == null) continue;
    const pid = phoneIdOfStream(item.id);
    const isMic = String(item.id).endsWith('#mic');
    let a = agg.get(pid);
    if (!a) {
      a = { id: pid, playing: false, bufferMs: 0, targetMs: 0, micBufferMs: 0, appBufferMs: 0, peak: 0 };
      agg.set(pid, a);
    }
    a.peak = Math.max(a.peak, item.peak || 0);
    if (isMic) a.micBufferMs = Math.max(a.micBufferMs, item.bufferMs || 0);
    else a.appBufferMs = Math.max(a.appBufferMs, item.bufferMs || 0);
    a.bufferMs = Math.max(a.bufferMs, item.bufferMs || 0);
    a.targetMs = Math.max(a.targetMs, item.targetMs || 0);
    if (item.playing) a.playing = true;
  }

  for (const [pid, item] of agg) {
    phoneMix.set(pid, item);
    const p = phones.get(pid);
    if (!p || !p.els) continue;
    if (item.playing) setDot(p.els.dot, 'ok');
    else if (p.els.dot.className.indexOf('warn') < 0) setDot(p.els.dot, 'warn');
    if (p.els.buf) {
      const now = Math.round(item.bufferMs);
      const goal = Math.round(item.targetMs || 0);
      p.els.buf.textContent = item.bufferMs > 0
        ? (goal > 0 ? `缓冲 ${now} / ${goal} ms` : `缓冲 ${now} ms`)
        : '缓冲 —';
    }
  }
}

function onPlayerMessage(msg) {
  if (!msg) return;
  if (msg.type === 'meter') {
    bufMs = msg.bufferMs || 0;
    underruns = msg.underruns || 0;
    dropped = msg.dropped || 0;
    recvPeak = Math.max(recvPeak, msg.peak || 0);
    renderPhoneMeters(msg.phones || []);
    const playing = !!msg.playing;
    if (playing !== playerPlaying) {
      playerPlaying = playing;
      notPlayingSince = playing ? 0 : performance.now();
    }
    lastAudioAt = performance.now();
    renderRecvState();
  }
  if (msg.type === 'dropped' && typeof msg.dropped === 'number') {
    dropped = msg.dropped;
  }
  if (msg.type === 'gone' && msg.id != null) {
    // Phone-side silence suppression stops uploading the app stream; don't
    // leave a stale buffer reading on the card.
    const pid = phoneIdOfStream(msg.id);
    const p = phones.get(pid);
    if (p && p.els && p.els.buf) p.els.buf.textContent = '缓冲 —';
    phoneMix.delete(pid);
  }
}

/* ---------------- websocket ---------------- */

async function getInfo() {
  const res = await fetch('/api/info', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function initLink() {
  try {
    const info = await getInfo();
    room = info.room;
    $('roomCode').textContent = room;
  } catch (err) {
    log('无法读取服务器信息，请通过 http://localhost:8080 打开本页，而不是直接打开 HTML 文件。', 'err');
    return;
  }
  connectWS();
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&role=pc`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    log('WebSocket 创建失败：' + err.message, 'err');
    scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';

  const socket = ws;

  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    wsOpen = true;
    reconnectDelay = 2000;
    setDot($('linkDot'), 'ok');
    $('linkText').textContent = '服务器已连接';
    log('已连接服务器', 'ok');
    renderRecvState();
    socket.send(JSON.stringify({
      type: 'hello',
      info: { name: 'PC Web', ua: navigator.userAgent },
    }));
    startPing();
  });

  socket.addEventListener('message', (ev) => {
    if (ws !== socket) return;
    if (typeof ev.data === 'string') {
      handleText(ev.data);
    } else {
      onBinary(ev.data);
    }
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    wsOpen = false;
    peerConnected = false;
    for (const id of [...phones.keys()]) removePhone(id);
    setDot($('linkDot'), 'bad');
    setDot($('peerDot'), '');
    $('linkText').textContent = '连接已断开';
    $('peerText').textContent = '手机未连接';
    renderRecvState();
    stopPing();
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    if (ws !== socket) return;
    log('服务器连接异常', 'err');
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
    reconnectDelay = Math.min(10000, reconnectDelay + 1000);
  }, reconnectDelay);
}

function handleText(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === 'welcome') {
    applyPageStatus(1, msg.primary !== false);
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (info && typeof info.pcPages === 'number') {
        applyPageStatus(info.pcPages, info.pcPages <= 1);
      }
    }).catch(() => {});
    if (msg.room) {
      room = msg.room;
      $('roomCode').textContent = room;
    }
    setPhones(msg.phones || []);
    if (msg.activeTarget) activeTarget = msg.activeTarget;
    if (msg.hotkeys) {
      hotkeyConfig = msg.hotkeys;
      renderHotkeys();
    }
    if (typeof msg.pcMuted === 'boolean') {
      settings.playEnabled = !msg.pcMuted;
      updatePlaybackGain();
    }
    $('peerText').textContent = phones.size ? `手机 ${phones.size} 台` : '手机未连接';
    markPeer(msg.peer);
    renderHotkeyStatus();
    return;
  }
  if (msg.type === 'hotkeys') {
    if (msg.config) hotkeyConfig = msg.config;
    if (msg.status) hotkeyStatus = msg.status;
    renderHotkeys();
    updatePhoneSlots();
    return;
  }
  if (msg.type === 'hotkey-status') {
    hotkeyStatus = msg.status || hotkeyStatus;
    renderHotkeyStatus();
    return;
  }
  if (msg.type === 'active-target') {
    activeTarget = msg.target || 'global';
    renderHotkeyStatus();
    updatePhoneSlots();
    return;
  }
  if (msg.type === 'pc-pages') {
    applyPageStatus(msg.count || 1, msg.primary !== false);
    return;
  }
  if (msg.type === 'pc-mute') {
    settings.playEnabled = !msg.muted;
    saveSettings();
    updatePlaybackGain();
    log(msg.muted ? '电脑端已静音' : '电脑端已取消静音', 'warn');
    return;
  }
  if (msg.type === 'pc-action' && msg.action === 'toggle-monitor') {
    toggleMonitor().catch((err) => log('本地监听切换失败：' + (err.message || err), 'err'));
    return;
  }
  if (msg.type === 'hotkey-error') {
    log('快捷键：' + (msg.message || '动作失败'), 'warn');
    return;
  }
  if (msg.type === 'phones') {
    setPhones(msg.phones || []);
    return;
  }
  if (msg.type === 'phone-joined') {
    ensurePhone(String(msg.id), msg.name);
    log(`${msg.name || '手机'} 已加入（${phones.size} 台）`, 'ok');
    return;
  }
  if (msg.type === 'phone-left') {
    const p = phones.get(String(msg.id));
    removePhone(String(msg.id));
    log(`${p ? p.name : '手机'} 已断开`, 'warn');
    return;
  }
  if (msg.type === 'phone-info') {
    ensurePhone(String(msg.id), msg.info && msg.info.name, msg.info);
    return;
  }
  if (msg.type === 'peer') {
    markPeer(!!msg.connected);
    if (!msg.connected && !phones.size) {
      $('peerText').textContent = '手机未连接';
    }
    return;
  }
  if (msg.type === 'pong') {
    if (typeof msg.t === 'number') rtt = performance.now() - msg.t;
    return;
  }
  if (msg.type === 'peer-info') {
    return;
  }
}

function markPeer(connected) {
  peerConnected = phones.size > 0 || !!connected;
  setDot($('peerDot'), peerConnected ? 'ok' : 'warn');
  $('peerText').textContent = phones.size ? `手机 ${phones.size} 台`
    : (connected ? '手机已连接' : '手机未连接');
  renderRecvState();
}

function setPeer(connected) {
  peerConnected = connected;
  setDot($('peerDot'), connected ? 'ok' : 'warn');
  const n = phones.size;
  $('peerText').textContent = n === 0 ? '手机未连接' : `手机 ${n} 台`;
  renderRecvState();
}

/* ---------------- multiple phones ---------------- */

const phones = new Map(); // id -> { id, name, el, els, mute, volume }
const phoneStats = new Map(); // id -> { rate, channels, frames, bytes, lastAt }
const phoneMix = new Map(); // id -> latest mixer meter (playing / bufferMs)

function deviceKey(p) {
  return 'lanaudio.dev.' + String(p.deviceId || p.name || 'Android').toLowerCase();
}

function loadDevice(p) {
  try {
    const raw = localStorage.getItem(deviceKey(p))
      || localStorage.getItem('lanaudio.dev.' + String(p.name || 'Android').toLowerCase());
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Number.isFinite(d.volume)) p.volume = Math.max(0, Math.min(3, d.volume));
    if (Number.isFinite(d.micGain)) p.micGain = Math.max(0, Math.min(5, d.micGain));
    if (Number.isFinite(d.nr)) p.nr = Math.max(0, Math.min(100, d.nr));
    if (Number.isFinite(d.pan)) p.pan = Math.max(-1, Math.min(1, d.pan));
    if (Number.isFinite(d.catchup)) p.catchup = Math.max(0, Math.min(100, d.catchup));
    if (Number.isFinite(d.bufferMs)) {
      p.bufferMs = Math.max(20, Math.min(400, d.bufferMs));
    } else if (Number.isFinite(d.delayMs)) {
      // migrate old “output delay” value into the new absolute buffer target
      p.bufferMs = Math.max(20, Math.min(400, settings.bufferMs + d.delayMs));
    }
  } catch { /* ignore */ }
}

function saveDevice(p) {
  if (!p) return;
  try {
    localStorage.setItem(deviceKey(p), JSON.stringify({
      volume: p.volume,
      micGain: p.micGain,
      nr: p.nr,
      pan: p.pan,
      bufferMs: p.bufferMs,
      catchup: p.catchup,
    }));
  } catch { /* ignore */ }
}

function syncPhoneControls(p) {
  if (!p || !p.els) return;
  p.els.vol.value = String(Math.round((p.volume == null ? 1 : p.volume) * 100));
  p.els.micGain.value = String(Math.round((p.micGain == null ? 1 : p.micGain) * 100));
  p.els.micGainVal.textContent = p.els.micGain.value + '%';
  if (p.els.nr) {
    p.els.nr.value = String(Math.round(p.nr == null ? 0 : p.nr));
    p.els.nrVal.textContent = p.els.nr.value;
  }
  p.els.pan.value = String(p.pan || 0);
  p.els.buffer.value = String(Math.round(p.bufferMs == null ? settings.bufferMs : p.bufferMs));
  p.els.bufferVal.textContent = p.els.buffer.value + ' ms';
  const catchup = Math.round(p.catchup == null ? settings.catchup : p.catchup);
  p.els.catchup.value = String(catchup);
  p.els.catchupVal.textContent = catchupText(catchup);
  p.els.play.checked = !p.mute;
}

function applyMicCapability(p) {
  if (!p || !p.els) return;
  const capable = p.micSplit !== false;
  p.els.tune.classList.toggle('disabled', !capable);
  p.els.micGain.disabled = !capable;
  if (p.els.nr) p.els.nr.disabled = !capable;
  p.els.pan.disabled = !capable;
  p.els.tune.title = capable ? '' : '旧版 App 没有独立麦克风帧，请升级手机端到 1.2+';
}

function ensurePhone(id, name, flags) {
  let p = phones.get(id);
  if (p) {
    if (name && name !== p.name) {
      p.name = name;
      if (p.els && p.els.name) p.els.name.textContent = name;
      loadDevice(p);
      syncPhoneControls(p);
      setPhoneGain(p);
    }
    applyPhoneFlags(p, flags);
    return p;
  }
  p = {
    id,
    name: name || 'Android',
    el: null,
    els: null,
    mute: false,
    volume: 1,
    micGain: 1,
    nr: 0,
    pan: 0,
    bufferMs: settings.bufferMs,
    catchup: settings.catchup,
    micSplit: true,
    send: true,
    receive: true,
    sourceMode: 0,
    deviceId: '',
    drops: 0,
  };
  if (flags) {
    p.send = flags.send !== false;
    p.receive = flags.receive !== false;
    if (typeof flags.micSplit === 'boolean') p.micSplit = flags.micSplit;
    if (flags.deviceId) p.deviceId = String(flags.deviceId);
    if (Number.isFinite(flags.mode)) p.sourceMode = flags.mode;
  }
  loadDevice(p);
  phones.set(id, p);
  buildPhoneRow(p);
  syncPeerCount();
  setPhoneGain(p);
  return p;
}

function applyPhoneFlags(p, flags) {
  if (!flags || !p) return;
  if (typeof flags.send === 'boolean') p.send = flags.send;
  if (typeof flags.receive === 'boolean') p.receive = flags.receive;
  if (flags.deviceId && flags.deviceId !== p.deviceId) {
    p.deviceId = String(flags.deviceId);
    loadDevice(p);
    syncPhoneControls(p);
    setPhoneGain(p);
  }
  if (Number.isFinite(flags.mode)) p.sourceMode = flags.mode;
  if (Number.isFinite(flags.drops)) p.drops = flags.drops;
  if (typeof flags.micSplit === 'boolean' && flags.micSplit !== p.micSplit) {
    p.micSplit = flags.micSplit;
    applyMicCapability(p);
  }
  if (p.els && p.els.sourceMode) {
    p.els.sourceMode.value = String(p.sourceMode == null ? 0 : p.sourceMode);
  }
  if (p.els && p.els.remoteSend) p.els.remoteSend.checked = !!p.send;
  if (p.els && p.els.remoteRecv) p.els.remoteRecv.checked = !!p.receive;
  const mode = p.send && p.receive ? '收发' : p.send ? '仅发送' : p.receive ? '仅接收' : '空闲';
  p.mode = mode;
  if (p.els && p.els.mode) p.els.mode.textContent = mode;
}

function removePhone(id) {
  const p = phones.get(id);
  if (!p) return;
  if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
  phones.delete(id);
  if (playerNode) {
    playerNode.port.postMessage({ type: 'remove', id });
    playerNode.port.postMessage({ type: 'remove', id: id + '#mic' });
  }
  syncPeerCount();
}

function syncPeerCount() {
  const n = phones.size;
  setBadge($('phonesBadge'), `${n} 台`, n ? 'ok' : '');
  const empty = $('phoneEmpty');
  if (empty) empty.classList.toggle('hidden', n > 0);
  peerConnected = n > 0;
  setDot($('peerDot'), n ? 'ok' : 'warn');
  $('peerText').textContent = n === 0 ? '手机未连接' : `手机 ${n} 台`;
  renderRecvState();
}

function buildPhoneRow(p) {
  const row = document.createElement('div');
  row.className = 'phone-row';
  row.innerHTML = `
    <div class="phone-main">
      <span class="dot" data-dot></span>
      <span class="phone-name" data-name></span>
      <span class="phone-mode" data-mode></span>
      <span class="phone-rate" data-rate>—</span>
      <span class="phone-slot" data-slot></span>
    </div>
    <div class="phone-actions">
      <label class="switch small"><input type="checkbox" data-play checked><span></span></label>
      <input type="range" min="0" max="300" value="100" data-vol aria-label="音量">
      <button class="btn ghost small" data-kick>断开</button>
    </div>
    <div class="phone-remote">
      <label>音源 <select data-source-mode><option value="0">内部声音</option><option value="1">麦克风</option><option value="2">内部 + 麦克风</option></select></label>
      <label class="check"><input type="checkbox" data-remote-send>发电脑</label>
      <label class="check"><input type="checkbox" data-remote-recv>收电脑</label>
    </div>
    <div class="phone-tune">
      <label class="tune"><span>麦克风增益</span><input type="range" min="0" max="500" step="5" value="100" data-micgain><b data-micgain-val>100%</b></label>
      <label class="tune"><span>电脑降噪</span><input type="range" min="0" max="100" step="1" value="0" data-nr><b data-nr-val>0</b></label>
      <label class="tune"><span>麦克风声道</span><select data-pan><option value="-1">左</option><option value="0">中</option><option value="1">右</option></select></label>
      <label class="tune"><span>接收缓冲</span><input type="range" min="20" max="400" step="5" value="90" data-buffer><b data-buffer-val>90 ms</b></label>
      <label class="tune"><span>追赶速度</span><input type="range" min="0" max="100" step="1" value="25" data-catchup><b data-catchup-val>25 · 1.014x</b></label>
      <span class="phone-buf" data-buf>缓冲 —</span>
    </div>`;
  p.el = row;
  p.els = {
    dot: row.querySelector('[data-dot]'),
    name: row.querySelector('[data-name]'),
    mode: row.querySelector('[data-mode]'),
    rate: row.querySelector('[data-rate]'),
    play: row.querySelector('[data-play]'),
    vol: row.querySelector('[data-vol]'),
    kick: row.querySelector('[data-kick]'),
    tune: row.querySelector('.phone-tune'),
    micGain: row.querySelector('[data-micgain]'),
    micGainVal: row.querySelector('[data-micgain-val]'),
    nr: row.querySelector('[data-nr]'),
    nrVal: row.querySelector('[data-nr-val]'),
    sourceMode: row.querySelector('[data-source-mode]'),
    remoteSend: row.querySelector('[data-remote-send]'),
    remoteRecv: row.querySelector('[data-remote-recv]'),
    slot: row.querySelector('[data-slot]'),
    pan: row.querySelector('[data-pan]'),
    buffer: row.querySelector('[data-buffer]'),
    bufferVal: row.querySelector('[data-buffer-val]'),
    catchup: row.querySelector('[data-catchup]'),
    catchupVal: row.querySelector('[data-catchup-val]'),
    buf: row.querySelector('[data-buf]'),
  };
  p.els.name.textContent = p.name;
  p.els.rate.textContent = '无音频';
  applyPhoneFlags(p, { send: p.send, receive: p.receive });
  syncPhoneControls(p);
  applyMicCapability(p);
  setDot(p.els.dot, 'ok');
  row.dataset.id = p.id;

  p.els.play.addEventListener('change', () => {
    p.mute = !p.els.play.checked;
    setPhoneGain(p);
  });
  p.els.vol.addEventListener('input', () => {
    p.volume = Number(p.els.vol.value) / 100;
    setPhoneGain(p);
    if (!playerNode) {
      // The slider is a playback control: enable the output automatically
      // instead of silently doing nothing.
      enableAudio().catch(() => {});
    }
  });
  p.els.micGain.addEventListener('input', () => {
    p.micGain = Number(p.els.micGain.value) / 100;
    p.els.micGainVal.textContent = p.els.micGain.value + '%';
    setPhoneGain(p);
  });
  if (p.els.nr) p.els.nr.addEventListener('input', () => {
    p.nr = Number(p.els.nr.value);
    p.els.nrVal.textContent = String(p.nr);
    setPhoneGain(p);
  });
  if (p.els.sourceMode) p.els.sourceMode.addEventListener('change', () => {
    const source = Number(p.els.sourceMode.value) || 0;
    p.sourceMode = source;
    sendPhoneControl(p, 'set-mode', { source });
    log(`${p.name} 音源切换为 ${['内部声音', '麦克风', '内部 + 麦克风'][source]}`);
  });
  if (p.els.remoteSend) p.els.remoteSend.addEventListener('change', () => {
    p.send = p.els.remoteSend.checked;
    sendPhoneControl(p, 'set-send', { on: p.send });
    applyPhoneFlags(p, { send: p.send, receive: p.receive, mode: p.sourceMode });
    log(`${p.name} ${p.send ? '开启' : '关闭'}发电脑`);
  });
  if (p.els.remoteRecv) p.els.remoteRecv.addEventListener('change', () => {
    p.receive = p.els.remoteRecv.checked;
    sendPhoneControl(p, 'set-receive', { on: p.receive });
    applyPhoneFlags(p, { send: p.send, receive: p.receive, mode: p.sourceMode });
    log(`${p.name} ${p.receive ? '开启' : '关闭'}收电脑`);
  });
  p.els.pan.addEventListener('change', () => {
    p.pan = Number(p.els.pan.value) || 0;
    setPhoneGain(p);
  });
  p.els.buffer.addEventListener('input', () => {
    p.els.bufferVal.textContent = p.els.buffer.value + ' ms';
    clearTimeout(p.bufferTimer);
    p.bufferTimer = setTimeout(() => commitPhoneBuffer(p), 180);
  });
  p.els.buffer.addEventListener('change', () => {
    clearTimeout(p.bufferTimer);
    commitPhoneBuffer(p);
  });
  p.els.catchup.addEventListener('input', () => {
    p.els.catchupVal.textContent = catchupText(p.els.catchup.value);
    clearTimeout(p.catchupTimer);
    p.catchupTimer = setTimeout(() => commitPhoneCatchup(p), 150);
  });
  p.els.catchup.addEventListener('change', () => {
    clearTimeout(p.catchupTimer);
    commitPhoneCatchup(p);
  });
  p.els.kick.addEventListener('click', () => {
    try { ws.send(JSON.stringify({ type: 'kick', id: p.id })); } catch { /* ignore */ }
    log(`已请求断开 ${p.name}`, 'warn');
  });
  $('phoneList').appendChild(row);
}

function updatePhoneRow(p, extra) {
  if (!p.els) return;
  if (extra && extra.rate) p.els.rate.textContent = extra.rate;
}

function setPhones(list) {
  const seen = new Set();
  for (const item of list || []) {
    if (!item || item.id == null) continue;
    seen.add(String(item.id));
    ensurePhone(String(item.id), item.name, item);
  }
  for (const id of [...phones.keys()]) {
    if (!seen.has(id)) removePhone(id);
  }
  for (const p of phones.values()) {
    if (p.els) p.els.rate.textContent = '无音频';
  }
  syncPeerCount();
  updateHotkeySlotOptions();
  updatePhoneSlots();
}

function startPing() {
  stopPing();
  const tick = () => {
    if (!wsOpen) return;
    try { ws.send(JSON.stringify({ type: 'ping', t: performance.now() })); } catch { /* ignore */ }
  };
  tick();
  pingTimer = setInterval(tick, 2000);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

/* ---------------- stats loop ---------------- */

let lastTick = performance.now();

function statsLoop() {
  const now = performance.now();
  const dt = Math.max(0.2, (now - lastTick) / 1000);
  lastTick = now;

  const upKbps = (upBytes * 8) / 1000 / dt;
  const downKbps = (downBytes * 8) / 1000 / dt;
  upBytes = 0;
  downBytes = 0;

  $('statRtt').textContent = rtt == null ? '—' : Math.round(rtt) + ' ms';
  $('statUp').textContent = upKbps > 0 ? Math.round(upKbps) + ' kbps' : '0 kbps';
  $('statDown').textContent = downKbps > 0 ? Math.round(downKbps) + ' kbps' : '0 kbps';
  $('statBuf').textContent = Math.round(bufMs) + ' ms';
  $('statUnder').textContent = String(underruns);
  $('statDrop').textContent = String(dropped);

  let quality = '—';
  let qcls = '';
  if (peerConnected) {
    if (rtt != null && rtt < 60 && underruns === 0) { quality = '良好'; qcls = 'ok'; }
    else if (rtt != null && rtt < 180) { quality = '一般'; qcls = 'warn'; }
    else { quality = '较差'; qcls = 'warn'; }
  }
  setBadge($('qualityBadge'), quality, qcls);

  setBadge($('phonesBadge'), `${phones.size} 台`, phones.size ? 'ok' : '');
  updatePhoneSlots();
  $('peerText').textContent = phones.size === 0 ? '手机未连接'
    : (peerConnected ? `手机 ${phones.size} 台` : '手机未连接');

  for (const [id, p] of phones) {
    if (!p.els) continue;
    const mix = phoneMix.get(id);
    const live = phoneStats.get(id);
    const active = live && now - live.lastAt < 1500;
    if (mix && mix.playing) setDot(p.els.dot, 'ok');
    else if (active) setDot(p.els.dot, 'warn');
    else setDot(p.els.dot, '');
    if (active && live) {
      const kbps = Math.round((live.bytes * 8) / 1000 / dt);
      p.els.rate.textContent = `${live.rate / 1000} kHz · ${live.channels === 2 ? '立体声' : '单声道'} · ${kbps} kbps`;
      live.bytes = 0;
    } else if (!active) {
      p.els.rate.textContent = '无音频';
    }
    p.els.rate.title = p.drops ? `手机发送队列丢帧：${p.drops}` : '';
  }

  if (!hasSendSource()) {
    sendPeak *= 0.7;
  } else {
    sendPeak = Math.max(displayPeak, sendPeak * 0.55);
    displayPeak = 0;
  }
  recvPeak *= 0.55;

  setMeter($('sendBar'), $('sendPeak'), sendPeak);
  setMeter($('recvBar'), $('recvPeak'), recvPeak);

  renderRecvState();
}

/* ---------------- global hotkeys ---------------- */

function eventToHotkey(e) {
  if (!e || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return '';
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Enter'].includes(key)) return '';
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Win');
  if (!mods.length && !/^F\d/.test(key)) return '';
  return mods.concat(key).join('+');
}

function hotkeyTargetLabel(target) {
  if (!hotkeyConfig || !hotkeyConfig.targets) return target;
  const item = hotkeyConfig.targets[target];
  return item ? (item.label || target) : target;
}

function renderHotkeyStatus() {
  const badge = $('hotkeyBadge');
  if (badge) {
    const n = (hotkeyStatus.registered || []).length;
    if (n) setBadge(badge, `全局 ${n} 个`, 'ok');
    else setBadge(badge, '未注册', 'warn');
  }
  const status = $('hotkeyStatusText');
  if (status) {
    const errors = hotkeyStatus.errors && typeof hotkeyStatus.errors === 'object'
      ? Object.values(hotkeyStatus.errors) : [];
    status.textContent = errors.length
      ? '注册失败：' + errors.join('；')
      : '快捷键保存在本机；启动 LAN Audio.exe 后可在任何窗口使用。未启动时，仅本页面聚焦时生效。';
  }
  const active = $('activeTargetText');
  if (active) active.textContent = '当前控制目标：' + hotkeyTargetLabel(activeTarget);
}

function buildHotkeyField(label, combo, group, key, targetSlot) {
  const wrap = document.createElement('label');
  wrap.className = 'hotkey-field';
  const title = document.createElement('span');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = combo || '';
  input.placeholder = '留空 = 禁用';
  input.dataset.hkGroup = group;
  input.dataset.hkKey = key;
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') {
      input.value = '';
      return;
    }
    const value = eventToHotkey(e);
    if (value) input.value = value;
  });
  wrap.appendChild(title);
  wrap.appendChild(input);

  if (targetSlot) {
    const select = document.createElement('select');
    select.dataset.hkDevice = key;
    wrap.appendChild(select);
  }
  return wrap;
}

function updateHotkeySlotOptions() {
  if (!hotkeyConfig) return;
  const selects = document.querySelectorAll('[data-hk-device]');
  for (const select of selects) {
    const slot = select.dataset.hkDevice;
    const configured = hotkeyConfig.targets && hotkeyConfig.targets[slot]
      ? hotkeyConfig.targets[slot].deviceId : '';
    const current = select.value || configured;
    select.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '未分配（连接后自动绑定）';
    select.appendChild(auto);
    for (const p of phones.values()) {
      const option = document.createElement('option');
      option.value = p.deviceId || '';
      option.textContent = `${p.name}${p.deviceId ? ' · ' + p.deviceId.slice(-6) : ''}`;
      if (!option.value) option.disabled = true;
      select.appendChild(option);
    }
    if (current && ![...select.options].some((o) => o.value === current)) {
      const offline = document.createElement('option');
      offline.value = current;
      offline.textContent = '已分配 · ' + current.slice(-6) + '（未连接）';
      select.appendChild(offline);
    }
    if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  }
}

function renderHotkeys() {
  const form = $('hotkeyForm');
  if (!form) return;
  form.textContent = '';
  if (!hotkeyConfig) {
    const p = document.createElement('p');
    p.className = 'micro';
    p.textContent = '快捷键配置尚未读取。';
    form.appendChild(p);
    return;
  }

  const targetBox = document.createElement('div');
  targetBox.className = 'hotkey-group';
  const targetHead = document.createElement('h3');
  targetHead.textContent = '目标选择';
  targetBox.appendChild(targetHead);
  const targetGrid = document.createElement('div');
  targetGrid.className = 'hotkey-grid';
  for (const [key, item] of Object.entries(hotkeyConfig.targets || {})) {
    targetGrid.appendChild(buildHotkeyField(item.label || key, item.hotkey, 'targets', key, key !== 'global'));
  }
  targetBox.appendChild(targetGrid);
  form.appendChild(targetBox);

  const actionBox = document.createElement('div');
  actionBox.className = 'hotkey-group';
  const actionHead = document.createElement('h3');
  actionHead.textContent = '动作（作用于当前控制目标）';
  actionBox.appendChild(actionHead);
  const actionGrid = document.createElement('div');
  actionGrid.className = 'hotkey-grid';
  for (const [key, item] of Object.entries(hotkeyConfig.actions || {})) {
    actionGrid.appendChild(buildHotkeyField(item.label || key, item.hotkey, 'actions', key, false));
  }
  actionBox.appendChild(actionGrid);
  form.appendChild(actionBox);

  updateHotkeySlotOptions();
  renderHotkeyStatus();
}

async function loadHotkeys() {
  try {
    const res = await fetch('/api/hotkeys', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    hotkeyConfig = data.config;
    hotkeyStatus = data.status || { registered: [], errors: {} };
    activeTarget = data.activeTarget || activeTarget;
    renderHotkeys();
  } catch (err) {
    const badge = $('hotkeyBadge');
    if (badge) setBadge(badge, '读取失败', 'err');
    log('快捷键配置读取失败：' + (err.message || err), 'warn');
  }
}

async function saveHotkeys() {
  if (!hotkeyConfig) return;
  const config = JSON.parse(JSON.stringify(hotkeyConfig));
  for (const input of document.querySelectorAll('[data-hk-group]')) {
    const group = input.dataset.hkGroup;
    const key = input.dataset.hkKey;
    if (config[group] && config[group][key]) config[group][key].hotkey = input.value.trim();
  }
  for (const select of document.querySelectorAll('[data-hk-device]')) {
    const key = select.dataset.hkDevice;
    if (config.targets && config.targets[key]) config.targets[key].deviceId = select.value || '';
  }
  try {
    const res = await fetch('/api/hotkeys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    hotkeyConfig = data.config || config;
    renderHotkeys();
    log('快捷键已保存，正在等待 LAN Audio.exe 重新注册…', 'ok');
  } catch (err) {
    log('快捷键保存失败：' + (err.message || err), 'err');
  }
}

async function applyHotkey(action, target) {
  try {
    const res = await fetch('/api/hotkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action || '', target: target || activeTarget }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) log(data.error || '快捷键动作失败', 'warn');
  } catch (err) {
    log('快捷键动作失败：' + (err.message || err), 'warn');
  }
}

function findHotkey(combo) {
  if (!hotkeyConfig || !combo) return null;
  for (const [key, item] of Object.entries(hotkeyConfig.targets || {})) {
    if (item.hotkey === combo) return { target: key, action: '' };
  }
  for (const [key, item] of Object.entries(hotkeyConfig.actions || {})) {
    if (item.hotkey === combo) return { target: activeTarget, action: key };
  }
  return null;
}

function bindHotkeyGlobalFallback() {
  $('btnSaveHotkeys').addEventListener('click', () => saveHotkeys());
  $('btnReloadHotkeys').addEventListener('click', () => loadHotkeys());
  document.addEventListener('keydown', (e) => {
    if (!hotkeyConfig || e.defaultPrevented) return;
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const combo = eventToHotkey(e);
    if (!combo) return;
    const match = findHotkey(combo);
    if (!match) return;
    // A registered Windows global hotkey will not reach the page; if the
    // launcher is absent, this fallback keeps the page usable while focused.
    if ((hotkeyStatus.registered || []).includes(combo)) return;
    e.preventDefault();
    applyHotkey(match.action, match.target);
  }, true);
}

function updatePhoneSlots() {
  if (!hotkeyConfig) return;
  for (const p of phones.values()) {
    if (!p.els || !p.els.slot) continue;
    let label = '';
    for (const [key, item] of Object.entries(hotkeyConfig.targets || {})) {
      if (key !== 'global' && p.deviceId && item.deviceId === p.deviceId) {
        label = item.label || key;
      }
    }
    p.els.slot.textContent = label;
  }
}

/* ---------------- boot ---------------- */

function boot() {
  bindControls();
  bindHotkeyGlobalFallback();
  syncControls();
  loadHotkeys();
  initLink();

  // allow the first user gesture anywhere to unlock audio output
  document.addEventListener('pointerdown', () => {
    if (!audioReady && !audioStarting) enableAudio().catch(() => {});
  }, { once: true });

  setInterval(statsLoop, 1000);

  if (isFirefox) {
    log('检测到 Firefox：接收手机声音、麦克风正常；捕获系统声音请改用 Edge/Chrome。', 'warn');
  }
  if (!window.isSecureContext) {
    log('当前不是安全上下文，麦克风/屏幕捕获可能被浏览器拒绝。请使用 http://localhost:8080 打开。', 'warn');
  }
  log('页面已就绪，等待连接…');
}

boot();
