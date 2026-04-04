'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  simConnected:    false,
  tracking:        false,
  phase:           'idle',
  lastData:        null,
  routePoints:     [],
  takeoffTime:     null,
  timerInterval:   null,
  pendingFlight:   null,   // completed flight awaiting submit
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const simStatusPill    = $('sim-status-pill');
const simStatusLabel   = $('sim-status-label');
const connTitle        = $('conn-title');
const connDesc         = $('conn-desc');
const btnConnect       = $('btn-connect');
const btnToggleTracking = $('btn-toggle-tracking');
const phaseBadge       = $('phase-badge');
const phaseLabel       = $('phase-label');
const depIcao          = $('dep-icao');
const arrIcao          = $('arr-icao');
const flightTimer      = $('flight-timer');
const trackingPill     = $('tracking-status-pill');
const trackingLabel    = $('tracking-label');
const lastUpdate       = $('last-update');
const versionTag       = $('version-tag');
const mapCanvas        = $('map-canvas');
const mapCoords        = $('map-coords');
const eventLog         = $('event-log');
const completeBanner   = $('flight-complete-banner');
const bannerTitle      = $('banner-title');
const bannerDetail     = $('banner-detail');

// ── Map canvas setup ───────────────────────────────────────────────────────
const ctx = mapCanvas.getContext('2d');

function resizeCanvas() {
  const parent = mapCanvas.parentElement;
  const rect   = parent.getBoundingClientRect();
  mapCanvas.width  = rect.width  - 20;
  mapCanvas.height = 180;
  drawMap();
}

// Mercator projection: lat/lon → canvas x/y
function project(lat, lon, w, h, bounds) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const padX = w * 0.08, padY = h * 0.08;
  const x = padX + ((lon - minLon) / (maxLon - minLon)) * (w - 2 * padX);
  // Invert lat (north = top)
  const y = padY + ((maxLat - lat) / (maxLat - minLat)) * (h - 2 * padY);
  return { x, y };
}

function drawMap() {
  const w = mapCanvas.width;
  const h = mapCanvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#0c1628';
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const x = (w / 8) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = (h / 5) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const pts = state.routePoints;
  if (pts.length === 0) {
    // Draw placeholder text
    ctx.fillStyle = 'rgba(71,85,105,0.6)';
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Route will appear here once airborne', w / 2, h / 2);
    return;
  }

  // Compute bounds with padding
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  // Add a bit of padding around the bounds
  const latPad = Math.max((maxLat - minLat) * 0.2, 0.5);
  const lonPad = Math.max((maxLon - minLon) * 0.2, 1.0);
  const bounds = {
    minLat: minLat - latPad, maxLat: maxLat + latPad,
    minLon: minLon - lonPad, maxLon: maxLon + lonPad,
  };

  // Draw route line
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(59,130,246,0.6)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length; i++) {
    const { x, y } = project(pts[i].lat, pts[i].lon, w, h, bounds);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Route glow
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(59,130,246,0.15)';
  ctx.lineWidth = 6;
  for (let i = 0; i < pts.length; i++) {
    const { x, y } = project(pts[i].lat, pts[i].lon, w, h, bounds);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Departure dot
  const dep = project(pts[0].lat, pts[0].lon, w, h, bounds);
  ctx.beginPath();
  ctx.arc(dep.x, dep.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#10b981';
  ctx.fill();

  // Current position dot
  const cur = project(pts[pts.length - 1].lat, pts[pts.length - 1].lon, w, h, bounds);
  ctx.beginPath();
  ctx.arc(cur.x, cur.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#3b82f6';
  ctx.fill();
  // Pulse ring
  ctx.beginPath();
  ctx.arc(cur.x, cur.y, 8, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(59,130,246,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer() {
  state.takeoffTime = Date.now();
  state.timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function updateTimer() {
  if (!state.takeoffTime) return;
  const elapsed = Date.now() - state.takeoffTime;
  const h = Math.floor(elapsed / 3600000);
  const m = Math.floor((elapsed % 3600000) / 60000);
  const s = Math.floor((elapsed % 60000) / 1000);
  flightTimer.textContent =
    `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Event log ──────────────────────────────────────────────────────────────
function addEvent(type, text) {
  // Remove placeholder if present
  const placeholder = eventLog.querySelector('.event-placeholder');
  if (placeholder) placeholder.remove();

  const icons = {
    takeoff:  '🛫',
    landing:  '🛬',
    complete: '✅',
    info:     'ℹ️',
    error:    '⚠️',
  };

  const item = document.createElement('div');
  item.className = `event-item ${type}`;
  item.innerHTML = `
    <span class="evt-icon">${icons[type] || 'ℹ️'}</span>
    <span>${text}</span>
    <span class="evt-time">${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</span>
  `;
  eventLog.insertBefore(item, eventLog.firstChild);

  // Keep log bounded
  while (eventLog.children.length > 20) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

// ── SimConnect status UI ───────────────────────────────────────────────────
function setSimStatus(status, message) {
  simStatusPill.className = `status-pill ${status}`;
  simStatusLabel.textContent = message;

  switch (status) {
    case 'connected':
      connTitle.textContent = 'SimConnect Connected';
      connDesc.textContent  = 'Reading flight data from Microsoft Flight Simulator';
      btnConnect.innerHTML  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Disconnect`;
      btnConnect.className  = 'btn btn-sm btn-danger';
      btnToggleTracking.disabled = false;
      state.simConnected = true;
      break;

    case 'connecting':
      connTitle.textContent = 'Connecting to SimConnect…';
      connDesc.textContent  = 'Waiting for Microsoft Flight Simulator';
      btnConnect.innerHTML  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Cancel`;
      btnConnect.className  = 'btn btn-sm';
      btnToggleTracking.disabled = true;
      state.simConnected = false;
      break;

    case 'error':
      connTitle.textContent = 'Connection Failed';
      connDesc.textContent  = message || 'MSFS not running or SimConnect unavailable';
      btnConnect.innerHTML  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5.47L1 10"/></svg> Retry`;
      btnConnect.className  = 'btn btn-sm btn-primary';
      btnToggleTracking.disabled = true;
      state.simConnected = false;
      break;

    default: // disconnected
      connTitle.textContent = 'Not Connected';
      connDesc.textContent  = 'Click Connect to link to Microsoft Flight Simulator';
      btnConnect.innerHTML  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connect`;
      btnConnect.className  = 'btn btn-sm btn-primary';
      btnToggleTracking.disabled = true;
      state.simConnected = false;
  }
}

// ── Phase UI ───────────────────────────────────────────────────────────────
const PHASE_LABELS = {
  idle:         { text: 'Idle',          icon: '✈' },
  pre_flight:   { text: 'Pre-Flight',    icon: '🔧' },
  taxi:         { text: 'Taxiing',       icon: '🚕' },
  takeoff_roll: { text: 'Takeoff Roll',  icon: '🛫' },
  airborne:     { text: 'Airborne',      icon: '✈' },
  climb:        { text: 'Climbing',      icon: '↗' },
  cruise:       { text: 'Cruise',        icon: '✈' },
  descent:      { text: 'Descending',    icon: '↘' },
  approach:     { text: 'Approach',      icon: '📍' },
  landing:      { text: 'Landing',       icon: '🛬' },
  post_flight:  { text: 'Post-Flight',   icon: '🅿' },
};

function setPhase(phase, prev) {
  state.phase = phase;
  const info = PHASE_LABELS[phase] || PHASE_LABELS.idle;

  phaseBadge.className = `phase-badge ${phase}`;
  phaseLabel.textContent = info.text;
  phaseBadge.querySelector('.phase-icon').textContent = info.icon;

  // Tracking pill
  if (['climb','cruise','descent','approach','airborne'].includes(phase)) {
    trackingPill.className = 'status-pill tracking';
    trackingLabel.textContent = 'Tracking Active';
    if (!state.takeoffTime) startTimer();
  } else if (phase === 'idle' || phase === 'pre_flight') {
    trackingPill.className = 'status-pill';
    trackingLabel.textContent = 'Not Tracking';
    stopTimer();
    flightTimer.textContent = '00:00:00';
  }
}

// ── Flight data UI ─────────────────────────────────────────────────────────
function updateMetrics(d) {
  if (!d) return;

  $('m-altitude').innerHTML = `${d.altitude.toLocaleString()}<span class="metric-unit">ft</span>`;
  $('m-ias').innerHTML      = `${d.ias}<span class="metric-unit">kt</span>`;

  const vsColor = d.vs > 0 ? 'var(--green)' : d.vs < -800 ? 'var(--red)' : 'var(--amber)';
  $('m-vs').style.color = vsColor;
  $('m-vs').innerHTML   = `${d.vs > 0 ? '+' : ''}${d.vs.toLocaleString()}<span class="metric-unit">fpm</span>`;

  $('m-hdg').innerHTML  = `${String(d.heading).padStart(3,'0')}<span class="metric-unit">°</span>`;
  $('m-gs').innerHTML   = `${d.groundSpeed}<span class="metric-unit">kt</span>`;
  $('m-fuel').innerHTML = `${Math.round(d.fuelGallons).toLocaleString()}<span class="metric-unit">gal</span>`;

  const gColor = d.gForce > 2 ? 'var(--red)' : d.gForce > 1.5 ? 'var(--amber)' : 'var(--text-primary)';
  $('m-gforce').style.color = gColor;
  $('m-gforce').innerHTML   = `${d.gForce.toFixed(2)}<span class="metric-unit">G</span>`;

  // Systems: gear, flaps, autopilot
  const gear = d.gearDown ? '⚙ Gear↓' : '⚙ Gear↑';
  const flaps = d.flapsIndex > 0 ? `Flaps ${d.flapsIndex}` : 'Flaps 0';
  const ap = d.autopilot ? '🟢 AP' : 'AP Off';
  $('m-systems').innerHTML = `<span style="font-size:10px; color:var(--text-secondary);">${gear} · ${flaps} · ${ap}</span>`;

  // Position
  mapCoords.textContent =
    `${d.lat.toFixed(4)}° ${d.lat >= 0 ? 'N' : 'S'}  ${Math.abs(d.lon).toFixed(4)}° ${d.lon >= 0 ? 'E' : 'W'}`;

  // Update route
  state.routePoints = state.routePoints.concat([]);  // copy preserved
  drawMap();

  // Last update timestamp
  lastUpdate.textContent = `Updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;
}

// ── Settings panel ─────────────────────────────────────────────────────────
const settingsOverlay = $('settings-overlay');

async function openSettings() {
  const s = await window.tracker.loadSettings();
  $('inp-api-url').value   = s.apiUrl   || 'https://simcrewops.com';
  $('inp-api-token').value = s.apiToken || '';
  $('chk-auto-connect').checked = !!s.autoConnect;
  $('chk-tray').checked         = !!s.minimizeToTray;
  $('verify-status').style.display = 'none';
  settingsOverlay.classList.add('open');
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
}

async function saveSettings() {
  const settings = {
    apiUrl:         $('inp-api-url').value.trim(),
    apiToken:       $('inp-api-token').value.trim(),
    autoConnect:    $('chk-auto-connect').checked,
    minimizeToTray: $('chk-tray').checked,
  };
  await window.tracker.saveSettings(settings);
  closeSettings();
  addEvent('info', 'Settings saved');
}

async function verifyToken() {
  const status = $('verify-status');
  status.style.display = 'block';
  status.style.background = 'var(--bg-elevated)';
  status.style.color = 'var(--text-secondary)';
  status.textContent = 'Verifying…';

  // Temporarily save so we can test
  await window.tracker.saveSettings({
    apiUrl:   $('inp-api-url').value.trim(),
    apiToken: $('inp-api-token').value.trim(),
  });

  try {
    const result = await window.tracker.submitFlight({
      sessionDate: new Date().toISOString().split('T')[0],
      aircraft:    'TEST',
      duration:    1,
      simVersion:  'MSFS 2024',
    });
    // If we get here without an error, consider it valid
    status.style.background = 'var(--green-dim)';
    status.style.color = '#34d399';
    status.textContent = '✓ API key is valid and connected';
  } catch (err) {
    if (err.message?.includes('token') || err.message?.includes('Unauthorized')) {
      status.style.background = 'var(--red-dim)';
      status.style.color = '#f87171';
      status.textContent = '✗ Invalid API key — check your SimCrewOps settings';
    } else {
      status.style.background = 'var(--amber-dim)';
      status.style.color = '#fcd34d';
      status.textContent = `⚠ ${err.message}`;
    }
  }
}

// ── Completed flight banner ────────────────────────────────────────────────
function showCompleteBanner(record) {
  state.pendingFlight = record;

  const dep = record.departure || '—';
  const arr = record.arrival   || '—';
  const dur = record.duration  || 0;
  const h   = Math.floor(dur / 60);
  const m   = dur % 60;
  const lr  = record.landingRate ? `${record.landingRate} fpm` : '—';

  bannerTitle.textContent  = `Flight Complete: ${dep} → ${arr}`;
  bannerDetail.textContent =
    `Duration: ${h}h ${m}m · Landing Rate: ${lr} · Max Alt: ${(record.maxAltitude || 0).toLocaleString()} ft`;

  completeBanner.classList.add('show');
  depIcao.textContent = dep;
  arrIcao.textContent = arr;
}

async function submitFlight() {
  if (!state.pendingFlight) return;
  const btn = $('btn-submit-flight');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const result = await window.tracker.submitFlight(state.pendingFlight);
  if (result.success) {
    addEvent('complete', `Flight ${state.pendingFlight.departure || '?'} → ${state.pendingFlight.arrival || '?'} logged to SimCrewOps`);
    completeBanner.classList.remove('show');
    state.pendingFlight = null;
  } else {
    btn.disabled = false;
    btn.textContent = 'Retry Submit';
    addEvent('error', `Submit failed: ${result.error}`);
  }
}

// ── Wire up events from main process ──────────────────────────────────────
window.tracker.on('simconnect:status', ({ state: s, message, info }) => {
  setSimStatus(s, message);
  if (s === 'connected') {
    addEvent('info', `Connected to ${info?.simVersion ?? 'MSFS'}`);
  } else if (s === 'disconnected') {
    addEvent('info', 'SimConnect disconnected');
    setPhase('idle');
    // Clear metrics
    ['m-altitude','m-ias','m-vs','m-hdg','m-gs','m-fuel','m-gforce'].forEach((id) => {
      $(id).innerHTML = '—';
    });
    $('m-systems').innerHTML = '—';
  } else if (s === 'error') {
    addEvent('error', message || 'Connection error');
  }
});

window.tracker.on('flight:data', (data) => {
  if (!data) return;
  state.lastData = data;

  // Track route points from renderer side too (for map)
  const last = state.routePoints[state.routePoints.length - 1];
  if (!last || Math.abs(data.lat - last.lat) > 0.01 || Math.abs(data.lon - last.lon) > 0.01) {
    state.routePoints.push({ lat: data.lat, lon: data.lon, alt: data.altitude });
    if (state.routePoints.length > 500) state.routePoints.shift(); // cap
  }

  updateMetrics(data);
});

window.tracker.on('flight:phase', ({ phase, prev }) => {
  setPhase(phase, prev);
});

window.tracker.on('flight:event', (event) => {
  if (event.type === 'takeoff') {
    const airport = event.airport || 'unknown';
    addEvent('takeoff', `Takeoff from ${airport} · IAS ${event.ias} kt`);
    depIcao.textContent = airport;
    state.routePoints = []; // Reset route at takeoff
    startTimer();
  } else if (event.type === 'landing') {
    const airport = event.airport || 'unknown';
    const lr = event.landingRate ?? '—';
    const g  = event.gForce?.toFixed(2) ?? '—';
    addEvent('landing', `Landed at ${airport} · Rate: ${lr} fpm · G: ${g}`);
    arrIcao.textContent = airport;
    stopTimer();
  }
});

window.tracker.on('flight:complete', (record) => {
  showCompleteBanner(record);
});

window.tracker.on('api:submit', ({ success, error }) => {
  if (success) {
    addEvent('complete', 'Flight submitted to SimCrewOps');
  } else {
    addEvent('error', `Auto-submit failed: ${error}`);
  }
});

// ── Button handlers ────────────────────────────────────────────────────────
btnConnect.addEventListener('click', () => {
  if (state.simConnected) {
    window.tracker.disconnect();
  } else {
    setSimStatus('connecting');
    window.tracker.connect();
  }
});

btnToggleTracking.addEventListener('click', () => {
  if (state.tracking) {
    state.tracking = false;
    btnToggleTracking.innerHTML =
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg> Start Tracking`;
    window.tracker.stopTracking();
    addEvent('info', 'Tracking stopped manually');
  } else {
    state.tracking = true;
    btnToggleTracking.innerHTML =
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="6" width="12" height="12"/></svg> Stop Tracking`;
    window.tracker.startTracking();
    addEvent('info', 'Tracking started');
  }
});

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', closeSettings);
$('btn-settings-cancel').addEventListener('click', closeSettings);
$('btn-settings-save').addEventListener('click', saveSettings);
$('btn-verify-token').addEventListener('click', verifyToken);

$('btn-submit-flight').addEventListener('click', submitFlight);
$('btn-dismiss-banner').addEventListener('click', () => {
  completeBanner.classList.remove('show');
  state.pendingFlight = null;
});

$('link-api-key').addEventListener('click', (e) => {
  e.preventDefault();
  window.tracker.openExternal('https://simcrewops.com/sim-tracker');
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// Window controls
$('btn-minimize').addEventListener('click', () => window.tracker.minimizeWindow());
$('btn-maximize').addEventListener('click', () => window.tracker.maximizeWindow());
$('btn-close').addEventListener('click',    () => window.tracker.closeWindow());

// ── Initialization ─────────────────────────────────────────────────────────
async function init() {
  // Detect platform
  if (navigator.platform.toLowerCase().includes('mac')) {
    document.body.classList.add('is-mac');
  }

  // Load initial app state
  const appState = await window.tracker.getState();
  if (appState.simConnected) {
    setSimStatus('connected');
  }

  // Version
  const version = await window.tracker.getVersion();
  versionTag.textContent = `v${version}`;

  // Resize canvas
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Initial draw
  drawMap();
}

// CSS keyframe for spinner
const style = document.createElement('style');
style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
document.head.appendChild(style);

init().catch(console.error);
