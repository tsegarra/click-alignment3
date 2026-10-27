'use strict';

const STEP = 0.03;
const SEGMENT_STEP = 0.1;
const SEGMENT_PRE = 0.3; // default segment start, seconds before the selected click
const SEGMENT_POST = 0.4; // default segment end, seconds after the selected click
const TICK_DURATION = 0.01;
const TICK_DECAY = 0.0015; // time constant of the tick's exponential decay
const TICK_FREQ = 1000;
const TICK_FREQ_SELECTED = 4000;
const TICK_GAIN = 1.0;
const AUDIO_GAIN = 0.6;

const ACTIONS = [
  { id: 'play', label: 'Play/Stop Selected Segment' },
  { id: 'clickMode', label: 'Click Selection mode (hold)', mode: 'Click Selection' },
  { id: 'wavMode', label: 'Wav Selection mode (hold)', mode: 'Wav Selection' },
  { id: 'extendMode', label: 'Segment End Move mode (hold)', mode: 'Segment End Move' },
  { id: 'startMode', label: 'Segment Start Move mode (hold)', mode: 'Segment Start Move' },
  { id: 'forward', label: 'Forward' },
  { id: 'back', label: 'Back' },
  { id: 'delete', label: 'Delete selected click' },
  { id: 'add', label: 'Add click' },
];
const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

const $ = (id) => document.getElementById(id);

// ---------- storage ----------

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function getAnnotations() {
  return readJSON('annotations', {});
}

function saveClicks() {
  const all = getAnnotations();
  all[state.fname] = state.clicks;
  localStorage.setItem('annotations', JSON.stringify(all));
}

function getMappings() {
  return readJSON('keyMappings', null); // { [code]: actionId }
}

// ---------- state ----------

const state = {
  wavs: [], // [{ url, fname }]
  wavIdx: 0,
  fname: '',
  buffer: null,
  duration: 0,
  clicks: [],
  sel: -1,
  segPre: SEGMENT_PRE, // segment bounds relative to the selected click
  segPost: SEGMENT_POST,
  loadToken: 0,
  heldModes: [], // action ids, most recent last
  mapping: null, // { step, codes: {} } while mapping keys
  message: '',
};

let audioCtx = null;
let playback = null; // { nodes: [] }
let tickBuffers = null; // { normal, selected }

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x) => Math.round(x * 1e6) / 1e6;
const fmt = (t) => t.toFixed(3) + 's';

// Absolute segment bounds, clipped to the clip's boundaries.
function segment() {
  const c = state.sel >= 0 ? state.clicks[state.sel] : state.segPre;
  return {
    start: round(clamp(c - state.segPre, 0, state.duration)),
    end: round(clamp(c + state.segPost, 0, state.duration)),
  };
}

// ---------- rendering ----------

function activeMode() {
  const id = state.heldModes[state.heldModes.length - 1];
  return id ? ACTION_BY_ID[id].mode : null;
}

function render() {
  $('title').textContent = state.fname || 'Loading…';
  $('wav-index').textContent = state.wavs.length ? `${state.wavIdx + 1} / ${state.wavs.length}` : '';
  const seg = segment();
  $('segment').textContent = state.buffer
    ? `−${fmt(state.segPre)} / +${fmt(state.segPost)} (${fmt(seg.start)} – ${fmt(seg.end)})`
    : '–';
  $('click').textContent = state.sel >= 0
    ? `${state.sel + 1} / ${state.clicks.length} @ ${fmt(state.clicks[state.sel])}`
    : (state.buffer ? 'No clicks' : '–');
  $('mode').textContent = activeMode() || 'None';
  $('playback').textContent = playback ? 'Playing' : 'Stopped';

  let msg = state.message;
  if (!msg && !state.mapping && !getMappings()) msg = 'No keys mapped. Press "Map Keys" to set them up.';
  $('message').textContent = msg;

  $('mapping-prompt').textContent = state.mapping
    ? `Press a key for: ${ACTIONS[state.mapping.step].label} (${state.mapping.step + 1}/${ACTIONS.length})`
      + (state.mapping.note ? ` — ${state.mapping.note}` : '')
    : '';
}

// ---------- loading ----------

async function fetchOrExplain(url, what) {
  let res;
  try {
    res = await fetch(encodeURI(url));
  } catch (e) {
    throw new Error(navigator.onLine
      ? `Could not fetch ${what}.`
      : `Offline: ${what} is not cached yet.`);
  }
  if (!res.ok) throw new Error(`Could not fetch ${what} (HTTP ${res.status}).`);
  return res;
}

async function loadWavList() {
  const res = await fetchOrExplain('wav_paths.txt', 'wav_paths.txt');
  const text = await res.text();
  state.wavs = text.split('\n').map((l) => l.trim()).filter(Boolean).map((url) => ({
    url,
    fname: decodeURIComponent(url.split('/').pop()),
  }));
}

async function loadWav(idx) {
  stop();
  const token = ++state.loadToken;
  const wav = state.wavs[idx];
  state.wavIdx = idx;
  state.fname = wav.fname;
  state.buffer = null;
  state.clicks = [];
  state.sel = -1;
  state.message = 'Loading…';
  render();

  try {
    const saved = getAnnotations()[wav.fname];
    const txtUrl = wav.url.replace('/audio_mixed/', '/syllable_guides/').replace(/\.wav$/i, '.txt');
    const [buffer, clicks] = await Promise.all([
      fetchOrExplain(wav.url, wav.fname)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx().decodeAudioData(ab)),
      Array.isArray(saved)
        ? saved.slice()
        : fetchOrExplain(txtUrl, 'click timestamps').then((r) => r.text()).then(parseClicks),
    ]);
    if (token !== state.loadToken) return;
    state.buffer = buffer;
    state.duration = buffer.duration;
    state.clicks = clicks;
    state.sel = clicks.length ? 0 : -1;
    state.message = '';
  } catch (e) {
    if (token !== state.loadToken) return;
    state.message = e.message || String(e);
  }
  render();
}

function parseClicks(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .map((ms) => round(ms / 1000)) // guide times are in milliseconds
    .sort((a, b) => a - b);
}

// ---------- playback ----------

// A damped cosine: starts at full amplitude for a sharp attack.
function makeTick(ac, freq) {
  const n = Math.round(TICK_DURATION * ac.sampleRate);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / ac.sampleRate;
    data[i] = Math.cos(2 * Math.PI * freq * t) * Math.exp(-t / TICK_DECAY);
  }
  return buf;
}

function ticks(ac) {
  if (!tickBuffers) {
    tickBuffers = { normal: makeTick(ac, TICK_FREQ), selected: makeTick(ac, TICK_FREQ_SELECTED) };
  }
  return tickBuffers;
}

function stop() {
  if (!playback) return;
  for (const n of playback.nodes) {
    n.onended = null;
    try { n.stop(); } catch (e) { /* already stopped */ }
  }
  playback = null;
}

function togglePlay() {
  if (playback) {
    stop();
    render();
    return;
  }
  if (!state.buffer) return;
  const ac = ctx();
  if (ac.state === 'suspended') ac.resume();

  const t0 = ac.currentTime + 0.05;
  const { start: segStart, end: segEnd } = segment();
  if (segEnd <= segStart) return;
  const src = ac.createBufferSource();
  src.buffer = state.buffer;
  const audioGain = ac.createGain();
  audioGain.gain.value = AUDIO_GAIN;
  src.connect(audioGain).connect(ac.destination);
  src.start(t0, segStart, segEnd - segStart);
  const nodes = [src];

  const tb = ticks(ac);
  const tickGain = ac.createGain();
  tickGain.gain.value = TICK_GAIN;
  tickGain.connect(ac.destination);
  state.clicks.forEach((c, i) => {
    if (c < segStart || c >= segEnd) return;
    const tick = ac.createBufferSource();
    tick.buffer = i === state.sel ? tb.selected : tb.normal;
    tick.connect(tickGain);
    tick.start(t0 + (c - segStart));
    nodes.push(tick);
  });

  const pb = { nodes };
  src.onended = () => {
    if (playback === pb) {
      playback = null;
      render();
    }
  };
  playback = pb;
  render();
}

// ---------- editing ----------

function moveSelectedClick(delta) {
  if (state.sel < 0) return;
  const t = round(clamp(state.clicks[state.sel] + delta, 0, state.duration));
  state.clicks.splice(state.sel, 1);
  let i = 0;
  while (i < state.clicks.length && state.clicks[i] < t) i++;
  state.clicks.splice(i, 0, t);
  state.sel = i;
  saveClicks();
}

function step(dir) {
  const mode = state.heldModes[state.heldModes.length - 1];

  if (mode === 'wavMode') {
    const next = state.wavIdx + dir;
    if (next >= 0 && next < state.wavs.length) loadWav(next);
    return;
  }
  if (!state.buffer) return;

  if (mode === 'clickMode') {
    if (state.sel >= 0) state.sel = clamp(state.sel + dir, 0, state.clicks.length - 1);
  } else if (mode === 'extendMode') {
    // Keep the end after the selected click so it is always heard.
    state.segPost = round(Math.max(SEGMENT_STEP, state.segPost + dir * SEGMENT_STEP));
  } else if (mode === 'startMode') {
    state.segPre = round(Math.max(0, state.segPre - dir * SEGMENT_STEP));
  } else {
    moveSelectedClick(dir * STEP);
  }
}

function deleteClick() {
  if (state.sel < 0) return;
  state.clicks.splice(state.sel, 1);
  if (state.sel >= state.clicks.length) state.sel = state.clicks.length - 1;
  saveClicks();
}

function addClick() {
  if (state.sel < 0 || state.sel >= state.clicks.length - 1) return;
  const t = round((state.clicks[state.sel] + state.clicks[state.sel + 1]) / 2);
  state.clicks.splice(state.sel + 1, 0, t);
  state.sel++;
  saveClicks();
}

// ---------- keyboard ----------

function onMappingKey(e) {
  e.preventDefault();
  if (e.repeat) return;
  const m = state.mapping;
  if (!e.code) {
    m.note = 'that key has no code, try another';
  } else if (m.codes[e.code]) {
    m.note = `${e.code} is already used for ${ACTION_BY_ID[m.codes[e.code]].label}`;
  } else {
    m.codes[e.code] = ACTIONS[m.step].id;
    m.note = '';
    m.step++;
    if (m.step === ACTIONS.length) {
      localStorage.setItem('keyMappings', JSON.stringify(m.codes));
      state.mapping = null;
    }
  }
  render();
}

function onKeyDown(e) {
  if (!$('export-view').hidden) return;
  if (state.mapping) return onMappingKey(e);

  const mappings = getMappings();
  const id = mappings && mappings[e.code];
  if (!id) return;
  e.preventDefault();

  const action = ACTION_BY_ID[id];
  if (e.repeat && id !== 'forward' && id !== 'back') return;

  if (action.mode) {
    state.heldModes = state.heldModes.filter((m) => m !== id);
    state.heldModes.push(id);
  } else if (id === 'play') {
    togglePlay();
  } else if (id === 'forward') {
    step(1);
  } else if (id === 'back') {
    step(-1);
  } else if (state.buffer) {
    if (id === 'delete') deleteClick();
    else if (id === 'add') addClick();
  }
  render();
}

function onKeyUp(e) {
  const mappings = getMappings();
  const id = mappings && mappings[e.code];
  if (!id || !ACTION_BY_ID[id].mode) return;
  e.preventDefault();
  state.heldModes = state.heldModes.filter((m) => m !== id);
  render();
}

// ---------- views ----------

function showView() {
  const exporting = location.hash === '#export';
  $('main-view').hidden = exporting;
  $('export-view').hidden = !exporting;
  if (exporting) {
    stop();
    state.heldModes = [];
    state.mapping = null;
    $('export-text').value = JSON.stringify(getAnnotations(), null, 2);
  }
  render();
}

function init() {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  // Key releases are missed while the page is unfocused.
  window.addEventListener('blur', () => { state.heldModes = []; render(); });
  window.addEventListener('hashchange', showView);

  $('map-keys').addEventListener('click', (e) => {
    e.currentTarget.blur(); // so Space/Enter don't re-trigger the button
    state.mapping = { step: 0, codes: {}, note: '' };
    render();
  });

  // Drop the cached app shell so the reload fetches the latest files.
  // Cached audio/click files and localStorage are kept.
  $('refresh-app').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith('shell-')).map((k) => caches.delete(k)));
      }
    } finally {
      location.reload();
    }
  });

  const ta = $('export-text');
  const selectAll = () => { ta.focus(); ta.setSelectionRange(0, ta.value.length); };
  ta.addEventListener('click', selectAll);
  ta.addEventListener('focus', selectAll);

  $('clear').addEventListener('click', () => {
    if (!confirm('Delete all annotation data? Key mappings are kept.')) return;
    localStorage.removeItem('annotations');
    ta.value = JSON.stringify({}, null, 2);
    if (state.wavs.length) loadWav(state.wavIdx); // re-initialize from provisional clicks
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  showView();
  loadWavList()
    .then(() => (state.wavs.length ? loadWav(0) : (state.message = 'wav_paths.txt is empty.', render())))
    .catch((e) => { state.message = e.message; render(); });
}

init();
