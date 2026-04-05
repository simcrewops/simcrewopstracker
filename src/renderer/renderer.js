'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  simConnected:  false,
  tracking:      false,
  phase:         'idle',
  lastData:      null,
  routePoints:   [],
  takeoffTime:   null,
  timerInterval: null,
  pendingFlight: null,
};

// ── Leaflet map state ──────────────────────────────────────────────────────
let leafletMap    = null;
let planeMarker   = null;
let routePolyline = null;
let depMarker     = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const btnConnect        = $('btn-connect');
const btnToggleTracking = $('btn-toggle-tracking');
const depIcao           = $('dep-icao');
const arrIcao           = $('arr-icao');
const flightTimer       = $('flight-timer');
const lastUpdate        = $('last-update');
const versionTag        = $('version-tag');
const mapCoords         = $('map-coords');
const eventLog          = $('event-log');
const completeBanner    = $('flight-complete-banner');
const bannerTitle       = $('banner-title');
const bannerDetail      = $('banner-detail');
const settingsOverlay   = $('settings-overlay');

// ── Phase order + mapping ──────────────────────────────────────────────────
const PHASE_ORDER = ['preflight','taxi_out','takeoff','climb','cruise','descent','approach','landing','taxi_in'];

const PHASE_TO_ID = {
  pre_flight:   'preflight',
  taxi:         'taxi_out',
  takeoff_roll: 'takeoff',
  airborne:     'climb',
  climb:        'climb',
  cruise:       'cruise',
  descent:      'descent',
  approach:     'approach',
  landing:      'landing',
  post_flight:  'taxi_in',
};

// ── Leaflet map ─────────────────────────────────────────────────────────────
function makePlaneIcon(color, sizePx, rotationDeg, isUser) {
  const glow = isUser
    ? 'drop-shadow(0 0 6px rgba(34,255,102,0.9))'
    : 'drop-shadow(0 0 3px rgba(0,0,0,0.8))';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"
      width="${sizePx}" height="${sizePx}"
      style="transform:rotate(${rotationDeg}deg);filter:${glow};display:block">
    <g fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="0.8">
      <path d="M20 2 C18.5 2 17.5 4 17.5 7 L17.5 15 L4 22 L4 25 L17.5 21
               L17.5 32 L13 35 L13 37 L20 35.5 L27 37 L27 35 L22.5 32
               L22.5 21 L36 25 L36 22 L22.5 15 L22.5 7 C22.5 4 21.5 2 20 2Z"/>
    </g>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize:   [sizePx, sizePx],
    iconAnchor: [sizePx / 2, sizePx / 2],
  });
}

function initMap() {
  if (typeof L === 'undefined') {
    console.warn('[tracker] Leaflet not available — map disabled');
    return;
  }

  leafletMap = L.map('map', {
    center: [38, -98],
    zoom: 4,
    zoomControl: true,
    attributionControl: false,
  });

  // Dark satellite tile layer (matches V4 mockup)
  // keepBuffer:1 and updateWhenIdle limit speculative tile fetches to reduce CPU/RAM churn.
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, keepBuffer: 1, updateWhenIdle: true }
  ).addTo(leafletMap);
}

function updateMap(data) {
  if (!leafletMap || !data) return;

  const { lat, lon, heading } = data;
  const icon = makePlaneIcon('#22ff66', 32, heading ?? 0, true);

  if (planeMarker) {
    planeMarker.setLatLng([lat, lon]);
    planeMarker.setIcon(icon);
  } else {
    planeMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 })
      .addTo(leafletMap);
  }

  // Update route polyline
  if (state.routePoints.length > 1) {
    const latlngs = state.routePoints.map(p => [p.lat, p.lon]);
    if (routePolyline) {
      routePolyline.setLatLngs(latlngs);
    } else {
      routePolyline = L.polyline(latlngs, {
        color: '#f48223',
        weight: 2.5,
        opacity: 0.75,
        dashArray: '8 5',
      }).addTo(leafletMap);
    }
  }

  // Smooth pan to current position
  leafletMap.panTo([lat, lon], { animate: true, duration: 0.5 });
}

function addDepMarker(lat, lon, icao) {
  if (!leafletMap) return;
  if (depMarker) leafletMap.removeLayer(depMarker);
  depMarker = L.circleMarker([lat, lon], {
    radius: 5,
    color: '#f48223',
    fillColor: '#f48223',
    fillOpacity: 0.9,
    weight: 1,
  }).bindTooltip(icao, { direction: 'bottom', offset: [0, 6] }).addTo(leafletMap);
}

function resetMap() {
  if (planeMarker)   { leafletMap.removeLayer(planeMarker);   planeMarker   = null; }
  if (routePolyline) { leafletMap.removeLayer(routePolyline); routePolyline = null; }
  if (depMarker)     { leafletMap.removeLayer(depMarker);     depMarker     = null; }
  if (leafletMap)    { leafletMap.setView([38, -98], 4); }
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
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Event log ──────────────────────────────────────────────────────────────
function addEvent(type, text) {
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
    <span class="evt-icon">${icons[type] ?? 'ℹ️'}</span>
    <span>${text}</span>
    <span class="evt-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
  `;
  eventLog.insertBefore(item, eventLog.firstChild);

  while (eventLog.children.length > 100) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

// ── SimConnect status UI ───────────────────────────────────────────────────
function setSimStatus(status, message) {
  const connStatus = $('conn-status');
  const connDot    = $('conn-dot');
  const connLabel  = $('conn-label');

  // Reset
  connStatus.className = '';
  connDot.className    = 'conn-dot';

  switch (status) {
    case 'connected':
      connStatus.className = 'connected';
      connDot.classList.add('connected');
      connLabel.textContent = 'Connected to MSFS';
      btnConnect.textContent = '⏹';
      btnConnect.title       = 'Disconnect from MSFS';
      btnConnect.className   = 'title-action-btn connected';
      btnToggleTracking.disabled = false;
      state.simConnected = true;
      $('sync-spinner').style.display = 'block';
      $('status-text').textContent = 'Connected — SimConnect active';
      break;

    case 'connecting':
      connStatus.className = 'connecting';
      connDot.classList.add('connecting');
      connLabel.textContent = 'Connecting…';
      btnConnect.textContent = '✕';
      btnConnect.title       = 'Cancel';
      btnConnect.className   = 'title-action-btn';
      btnToggleTracking.disabled = true;
      state.simConnected = false;
      $('sync-spinner').style.display = 'block';
      $('status-text').textContent = 'Connecting to Microsoft Flight Simulator…';
      break;

    case 'error':
      connStatus.className = 'error';
      connDot.classList.add('error');
      connLabel.textContent = 'Connection Failed';
      btnConnect.textContent = '⚡';
      btnConnect.title       = 'Retry connection';
      btnConnect.className   = 'title-action-btn';
      btnToggleTracking.disabled = true;
      state.simConnected = false;
      $('sync-spinner').style.display = 'none';
      $('status-text').textContent = message || 'MSFS not running or SimConnect unavailable';
      break;

    default: // disconnected
      connLabel.textContent = 'Disconnected';
      btnConnect.textContent = '⚡';
      btnConnect.title       = 'Connect to MSFS';
      btnConnect.className   = 'title-action-btn';
      btnToggleTracking.disabled = true;
      state.simConnected = false;
      $('sync-spinner').style.display = 'none';
      $('status-text').textContent = 'Not connected to MSFS';
  }
}

// ── Phase UI ───────────────────────────────────────────────────────────────
function setPhase(phase) {
  state.phase = phase;

  const currentId  = PHASE_TO_ID[phase];
  const currentIdx = PHASE_ORDER.indexOf(currentId);

  PHASE_ORDER.forEach((phId, idx) => {
    const el = $(`ph-${phId}`);
    if (!el) return;
    el.classList.remove('completed', 'active');
    if (currentId && idx < currentIdx)  el.classList.add('completed');
    if (currentId && idx === currentIdx) el.classList.add('active');
  });

  // Tracking pill
  const tPill  = $('tracking-status-pill');
  const tLabel = $('tracking-label');

  if (['airborne','climb','cruise','descent','approach'].includes(phase)) {
    if (tPill)  tPill.className = 'tracking';
    if (tLabel) tLabel.textContent = 'Tracking Active';
    if (!state.takeoffTime) startTimer();
    $('status-text').textContent = phaseDisplayName(phase);
  } else if (phase === 'idle' || phase === 'pre_flight') {
    if (tPill)  tPill.className = '';
    if (tLabel) tLabel.textContent = 'Not Tracking';
    stopTimer();
    flightTimer.textContent = '00:00:00';
    if (phase === 'idle') $('status-text').textContent = 'Connected — waiting for flight';
  } else {
    if (tLabel) tLabel.textContent = phaseDisplayName(phase);
    $('status-text').textContent = phaseDisplayName(phase);
  }
}

function phaseDisplayName(phase) {
  const map = {
    idle: 'Idle', pre_flight: 'Pre-Flight', taxi: 'Taxiing',
    takeoff_roll: 'Takeoff Roll', airborne: 'Airborne',
    climb: 'Climbing', cruise: 'Cruise', descent: 'Descending',
    approach: 'On Approach', landing: 'Landing', post_flight: 'Post-Flight',
  };
  return map[phase] || phase;
}

// ── Flight data UI ─────────────────────────────────────────────────────────
function updateMetrics(d) {
  if (!d) return;

  $('m-altitude').innerHTML = `${d.altitude.toLocaleString()}<span class="metric-unit">ft</span>`;
  $('m-ias').innerHTML      = `${d.ias}<span class="metric-unit">kt</span>`;

  const vsColor = d.vs > 0 ? '#6ee7b7' : d.vs < -800 ? '#f87171' : '#fcd34d';
  $('m-vs').style.color = vsColor;
  $('m-vs').innerHTML   = `${d.vs > 0 ? '+' : ''}${d.vs.toLocaleString()}<span class="metric-unit">fpm</span>`;

  $('m-hdg').innerHTML  = `${String(d.heading).padStart(3, '0')}<span class="metric-unit">°</span>`;
  $('m-gs').innerHTML   = `${d.groundSpeed}<span class="metric-unit">kt</span>`;
  $('m-fuel').innerHTML = `${Math.round(d.fuelGallons).toLocaleString()}<span class="metric-unit">gal</span>`;

  const gColor = d.gForce > 2 ? '#f87171' : d.gForce > 1.5 ? '#fcd34d' : 'inherit';
  $('m-gforce').style.color = gColor;
  $('m-gforce').innerHTML   = `${d.gForce.toFixed(2)}<span class="metric-unit">G</span>`;

  const gear  = d.gearDown ? '⚙ Gear↓' : '⚙ Gear↑';
  const flaps = d.flapsIndex > 0 ? `Flaps ${d.flapsIndex}` : 'Flaps 0';
  const ap    = d.autopilot ? '🟢 AP' : 'AP Off';
  $('m-systems').innerHTML =
    `<span style="font-size:10px; color:rgba(255,255,255,0.5);">${gear} · ${flaps} · ${ap}</span>`;

  mapCoords.textContent =
    `${d.lat.toFixed(4)}°${d.lat >= 0 ? 'N' : 'S'} ${Math.abs(d.lon).toFixed(4)}°${d.lon >= 0 ? 'E' : 'W'}`;

  lastUpdate.textContent =
    `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

  // Update the Leaflet map with current position + heading
  updateMap(d);
}

// ── Settings panel ─────────────────────────────────────────────────────────
async function openSettings() {
  const s = window.tracker ? await window.tracker.loadSettings() : {};
  $('inp-api-url').value        = s.apiUrl   || 'https://simcrewops.com';
  $('inp-api-token').value      = s.apiToken || '';
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
  if (window.tracker) await window.tracker.saveSettings(settings);
  closeSettings();
  addEvent('info', 'Settings saved');
}

async function verifyToken() {
  const status = $('verify-status');
  status.style.display    = 'block';
  status.style.background = 'rgba(255,255,255,0.04)';
  status.style.color      = 'rgba(255,255,255,0.5)';
  status.textContent      = 'Verifying…';

  if (window.tracker) await window.tracker.saveSettings({
    apiUrl:   $('inp-api-url').value.trim(),
    apiToken: $('inp-api-token').value.trim(),
  });

  try {
    if (!window.tracker) throw new Error('Not running in Electron');
    const result = await window.tracker.verifyToken();
    if (result.success) {
      status.style.background = 'rgba(74,222,128,0.1)';
      status.style.color      = '#34d399';
      status.textContent      = '✓ API key is valid and connected';
    } else {
      status.style.background = 'rgba(248,113,113,0.1)';
      status.style.color      = '#f87171';
      status.textContent      = `✗ ${result.error || 'Invalid API key — check your SimCrewOps settings'}`;
    }
  } catch (err) {
    status.style.background = 'rgba(250,204,21,0.1)';
    status.style.color      = '#fcd34d';
    status.textContent      = `⚠ ${err.message}`;
  }
}

// ── Flight complete banner ─────────────────────────────────────────────────
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
}

async function submitFlight() {
  if (!state.pendingFlight) return;
  const btn = $('btn-submit-flight');
  btn.disabled     = true;
  btn.textContent  = 'Submitting…';

  const result = await window.tracker.submitFlight(state.pendingFlight);
  if (result.success) {
    addEvent('complete', `Flight ${state.pendingFlight.departure || '?'} → ${state.pendingFlight.arrival || '?'} logged`);
    completeBanner.classList.remove('show');
    state.pendingFlight = null;
  } else {
    btn.disabled    = false;
    btn.textContent = '▶ Retry Submit';
    addEvent('error', `Submit failed: ${result.error}`);
  }
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const tab   = document.querySelector(`.tab[data-tab="${name}"]`);
  const panel = $(`tab-${name}`);
  if (tab)   tab.classList.add('active');
  if (panel) panel.classList.add('active');

  // Invalidate map size when the map tab becomes visible
  if (name === 'myflight' && leafletMap) {
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }
}

// ── Wire IPC events from main process ─────────────────────────────────────
// Guard: window.tracker only exists inside Electron (defined by preload.js).
// Without the guard the top-level calls below crash the script in any plain
// browser context (static preview, unit tests), breaking purely-UI features
// like tab switching that have nothing to do with the IPC bridge.
if (window.tracker) {

window.tracker.on('simconnect:status', ({ state: s, message, info }) => {
  setSimStatus(s, message);
  if (s === 'connected') {
    addEvent('info', `Connected to ${info?.simVersion ?? 'MSFS'}`);
  } else if (s === 'disconnected') {
    addEvent('info', 'SimConnect disconnected');
    setPhase('idle');
    ['m-altitude','m-ias','m-vs','m-hdg','m-gs','m-fuel','m-gforce'].forEach(id => {
      $(id).innerHTML = '—';
    });
    $('m-systems').innerHTML = '—';
    state.routePoints = [];
    resetMap();
  } else if (s === 'error') {
    addEvent('error', message || 'Connection error');
  }
});

window.tracker.on('flight:data', (data) => {
  if (!data) return;
  state.lastData = data;

  // Accumulate route points (throttled by movement)
  const last = state.routePoints[state.routePoints.length - 1];
  if (!last || Math.abs(data.lat - last.lat) > 0.01 || Math.abs(data.lon - last.lon) > 0.01) {
    state.routePoints.push({ lat: data.lat, lon: data.lon, alt: data.altitude });
    if (state.routePoints.length > 500) state.routePoints.shift();
  }

  updateMetrics(data);
});

window.tracker.on('flight:phase', ({ phase }) => {
  setPhase(phase);
});

window.tracker.on('flight:event', (event) => {
  if (event.type === 'takeoff') {
    const airport = event.airport || 'unknown';
    addEvent('takeoff', `Takeoff from ${airport} · IAS ${event.ias} kt`);
    depIcao.textContent = airport;

    // Reset route and place departure marker
    state.routePoints = [];
    if (state.lastData) {
      addDepMarker(state.lastData.lat, state.lastData.lon, airport);
    }
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

} // end if (window.tracker)

// ── Button handlers ────────────────────────────────────────────────────────
btnConnect.addEventListener('click', () => {
  if (!window.tracker) return;
  if (state.simConnected) {
    window.tracker.disconnect();
  } else {
    setSimStatus('connecting');
    window.tracker.connect();
  }
});

btnToggleTracking.addEventListener('click', () => {
  if (!window.tracker) return;
  if (state.tracking) {
    state.tracking = false;
    btnToggleTracking.innerHTML = '&#9654; Start Tracking';
    window.tracker.stopTracking();
    addEvent('info', 'Tracking stopped manually');
  } else {
    state.tracking = true;
    btnToggleTracking.innerHTML = '&#9646;&#9646; Stop Tracking';
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
  if (window.tracker) window.tracker.openExternal('https://simcrewops.com/sim-tracker');
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Window controls (Electron only)
$('btn-minimize').addEventListener('click', () => window.tracker?.minimizeWindow());
$('btn-maximize').addEventListener('click', () => window.tracker?.maximizeWindow());
$('btn-close').addEventListener('click',    () => window.tracker?.closeWindow());

// ── Initialisation ─────────────────────────────────────────────────────────
async function init() {
  // macOS: hide custom window controls, add padding for traffic lights
  if (navigator.platform.toLowerCase().includes('mac')) {
    document.body.classList.add('is-mac');
  }

  if (window.tracker) {
    // Load initial app state
    const appState = await window.tracker.getState();
    if (appState.simConnected) {
      setSimStatus('connected');
    }

    // Version
    const version = await window.tracker.getVersion();
    versionTag.textContent = `v${version}`;
  }

  // Init Leaflet map (works in all contexts)
  initMap();
}

init().catch(console.error);
