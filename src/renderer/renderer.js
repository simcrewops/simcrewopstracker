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
const btnToggleTracking = $('btn-toggle-tracking'); // may be null before index.html is fully synced
const depIcao           = $('dep-icao');
const arrIcao           = $('arr-icao');
const flightTimer       = $('flight-timer');
const versionTag        = $('version-tag');
const mapCoords         = $('map-coords');
const eventLog          = $('event-log');
const debriefCard       = $('debrief-card');
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
      if (btnToggleTracking) btnToggleTracking.disabled = false;
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
      if (btnToggleTracking) btnToggleTracking.disabled = true;
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
      if (btnToggleTracking) btnToggleTracking.disabled = true;
      state.simConnected = false;
      $('sync-spinner').style.display = 'none';
      $('status-text').textContent = message || 'MSFS not running or SimConnect unavailable';
      break;

    default: // disconnected
      connLabel.textContent = 'Disconnected';
      btnConnect.textContent = '⚡';
      btnConnect.title       = 'Connect to MSFS';
      btnConnect.className   = 'title-action-btn';
      if (btnToggleTracking) btnToggleTracking.disabled = true;
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

  const elAlt  = $('d-alt');
  if (elAlt)  elAlt.textContent  = d.altitude.toLocaleString();

  const elIas  = $('d-ias');
  if (elIas)  elIas.textContent  = String(d.ias);

  const elVs   = $('d-vs');
  if (elVs) {
    elVs.style.color = d.vs > 0 ? '#6ee7b7' : d.vs < -800 ? '#f87171' : '#fcd34d';
    elVs.textContent = `${d.vs > 0 ? '+' : ''}${d.vs.toLocaleString()}`;
  }

  const elHdg  = $('d-hdg');
  if (elHdg)  elHdg.textContent  = `${String(Math.round(d.heading)).padStart(3, '0')}°`;

  const elGs   = $('d-gs');
  if (elGs)   elGs.textContent   = String(Math.round(d.groundSpeed));

  const elFuel = $('d-fuel');
  if (elFuel) elFuel.textContent = Math.round(d.fuelGallons).toLocaleString();

  const elGf   = $('d-gforce');
  if (elGf) {
    elGf.style.color = d.gForce > 2 ? '#f87171' : d.gForce > 1.5 ? '#fcd34d' : 'inherit';
    elGf.textContent = d.gForce != null ? d.gForce.toFixed(2) : '—';
  }

  const elGear  = $('sys-gear');
  if (elGear)  elGear.textContent  = d.gearDown ? '⚙ Gear↓' : '⚙ Gear↑';

  const elFlaps = $('sys-flaps');
  if (elFlaps) elFlaps.textContent = d.flapsIndex > 0 ? `Flaps ${d.flapsIndex}` : 'Flaps 0';

  const elAp    = $('sys-ap');
  if (elAp)    elAp.textContent    = d.autopilot ? '🟢 AP' : 'AP Off';

  if (mapCoords) {
    mapCoords.textContent =
      `${d.lat.toFixed(4)}°${d.lat >= 0 ? 'N' : 'S'} ${Math.abs(d.lon).toFixed(4)}°${d.lon >= 0 ? 'E' : 'W'}`;
  }

  // Update the Leaflet map with current position + heading
  updateMap(d);
}

// ── Auth state UI ──────────────────────────────────────────────────────────
function applyAuthState(auth) {
  const signedIn  = $('auth-signed-in');
  const signedOut = $('auth-signed-out');
  if (!signedIn || !signedOut) return;

  if (auth && auth.isSignedIn && auth.user) {
    signedIn.style.display  = 'block';
    signedOut.style.display = 'none';
    const name = auth.user.name || auth.user.username || auth.user.email || 'Signed In';
    $('auth-user-name').textContent  = name;
    $('auth-user-email').textContent = auth.user.email || '';
  } else {
    signedIn.style.display  = 'none';
    signedOut.style.display = 'block';
  }
}

// ── Settings panel ─────────────────────────────────────────────────────────
async function openSettings() {
  const s = window.tracker ? await window.tracker.loadSettings() : {};
  $('inp-api-url').value        = s.apiUrl   || 'https://simcrewops.com';
  $('chk-auto-connect').checked = !!s.autoConnect;
  $('chk-tray').checked         = !!s.minimizeToTray;

  // Show current auth state
  if (window.tracker) {
    const auth = await window.tracker.getAuthStatus();
    applyAuthState(auth);
  }

  settingsOverlay.classList.add('open');
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
}

async function saveSettings() {
  const settings = {
    apiUrl:         $('inp-api-url').value.trim(),
    autoConnect:    $('chk-auto-connect').checked,
    minimizeToTray: $('chk-tray').checked,
  };
  if (window.tracker) await window.tracker.saveSettings(settings);
  closeSettings();
  addEvent('info', 'Settings saved');
}

// ── Grade computation ──────────────────────────────────────────────────────
function computeGrade(record) {
  const lr = Math.abs(record.landingRate ?? -9999);
  if (lr <= 100) return 'A';
  if (lr <= 200) return 'B';
  if (lr <= 350) return 'C';
  if (lr <= 500) return 'D';
  return 'F';
}

// ── Flight debrief card ────────────────────────────────────────────────────
function showCompleteBanner(record) {
  state.pendingFlight = record;
  if (!debriefCard) return;

  const dep  = record.departure || '—';
  const arr  = record.arrival   || '—';
  const dur  = record.duration  || 0;
  const h    = Math.floor(dur / 60);
  const m    = dur % 60;
  const lr   = record.landingRate != null ? `${record.landingRate} fpm` : '—';
  const gf   = record.maxGForce  != null ? `${record.maxGForce.toFixed(2)}G` : '—';
  const zone = record.touchdownZoneHit ? '✅ In Zone' : record.touchdownZoneHit === false ? '❌ Off Zone' : '—';
  const bounces = record.bounces ?? 0;
  const grade   = computeGrade(record);

  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setText('db-route',  `${dep} → ${arr}`);
  setText('db-sub',    `${h}h ${m}m · ${record.aircraft || 'UNKN'}`);
  setText('db-lr',     lr);
  setText('db-gforce', gf);
  setText('db-zone',   zone);
  setText('db-bounce', bounces);

  const elGrade = $('db-grade');
  if (elGrade) {
    elGrade.textContent = grade;
    elGrade.className   = `debrief-grade grade-${grade.toLowerCase()}`;
  }

  // Also update the in-flight grade badge in the flight card header
  const gradeBadge = $('grade-badge');
  if (gradeBadge) {
    gradeBadge.textContent    = grade;
    gradeBadge.style.display  = 'inline-flex';
  }

  debriefCard.style.display = 'block';
  debriefCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitFlight() {
  if (!state.pendingFlight) return;
  const btn = $('btn-submit-flight');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  const result = await window.tracker.submitFlight(state.pendingFlight);
  if (result.success) {
    addEvent('complete', `Flight ${state.pendingFlight.departure || '?'} → ${state.pendingFlight.arrival || '?'} logged`);
    if (debriefCard) debriefCard.style.display = 'none';
    state.pendingFlight = null;
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Retry Submit'; }
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
    ['d-alt','d-ias','d-vs','d-hdg','d-gs','d-fuel','d-gforce'].forEach(id => {
      const el = $(id); if (el) { el.textContent = '—'; el.style.color = ''; }
    });
    ['sys-gear','sys-flaps','sys-ap'].forEach(id => {
      const el = $(id); if (el) el.textContent = '—';
    });
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

window.tracker.on('auth:stateChanged', (auth) => {
  applyAuthState(auth);
  if (auth.isSignedIn && auth.user) {
    const name = auth.user.name || auth.user.email || 'user';
    addEvent('info', `Signed in as ${name}`);
  } else {
    addEvent('info', 'Signed out of SimCrewOps');
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

if (btnToggleTracking) {
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
}

// ── Map toggle ─────────────────────────────────────────────────────────────
(function () {
  const btnMapToggle = $('btn-map-toggle');
  const mapWrapper   = $('map-wrapper');
  if (!btnMapToggle || !mapWrapper) return;

  btnMapToggle.addEventListener('click', () => {
    const visible = mapWrapper.style.display !== 'none';
    mapWrapper.style.display = visible ? 'none' : 'block';
    btnMapToggle.classList.toggle('active', !visible);
    // Leaflet needs an explicit size recalculation after becoming visible
    if (!visible && leafletMap) {
      setTimeout(() => leafletMap.invalidateSize(), 50);
    }
  });
})();

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', closeSettings);
$('btn-settings-cancel').addEventListener('click', closeSettings);
$('btn-settings-save').addEventListener('click', saveSettings);

$('btn-sign-in').addEventListener('click', () => {
  if (window.tracker) window.tracker.signIn();
});

$('btn-sign-out').addEventListener('click', async () => {
  if (window.tracker) {
    await window.tracker.signOut();
    applyAuthState({ isSignedIn: false, user: null });
  }
});

const btnSubmitFlight = $('btn-submit-flight');
if (btnSubmitFlight) btnSubmitFlight.addEventListener('click', submitFlight);

const btnDismissDebrief = $('btn-dismiss-debrief');
if (btnDismissDebrief) {
  btnDismissDebrief.addEventListener('click', () => {
    if (debriefCard) debriefCard.style.display = 'none';
    state.pendingFlight = null;
  });
}

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

    // Apply initial auth state
    if (appState.auth) {
      applyAuthState(appState.auth);
    }

    // Version
    const version = await window.tracker.getVersion();
    versionTag.textContent = `v${version}`;
  }

  // Init Leaflet map (works in all contexts)
  initMap();
}

init().catch(console.error);
