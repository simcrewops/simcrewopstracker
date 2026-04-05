'use strict';

/**
 * SimCrewOps Tracker Renderer
 *
 * Performance principles:
 *   - A single requestAnimationFrame loop drives all DOM updates.
 *     Never update the DOM outside the RAF callback.
 *   - Dirty-check: track last-rendered values for every field and only
 *     touch innerHTML/textContent when the value actually changed.
 *   - IPC data is stored into plain JS objects (no DOM contact) as it
 *     arrives; the RAF loop reads from those objects once per frame.
 *   - The map is updated at most every 1 second (mapUpdateMs guard) and
 *     only when the tab containing it is visible.
 *   - No setInterval for UI work — only for the 1s flight timer display.
 */

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Phase order (matches index.html phase dot IDs) ────────────────────────────
const PHASE_ORDER = [
  'preflight', 'taxi_out', 'takeoff_roll', 'climb', 'cruise',
  'descent', 'approach', 'landing', 'taxi_in', 'post_flight',
];

// Internal phase names → DOM IDs
const PHASE_TO_ID = {
  idle:                 null,
  preflight:            'preflight',
  pre_flight:           'preflight',   // backward compat
  taxi_out:             'taxi_out',
  taxi:                 'taxi_out',    // backward compat
  takeoff_roll:         'takeoff_roll',
  airborne:             'climb',
  climb:                'climb',
  cruise:               'cruise',
  descent:              'descent',
  approach:             'approach',
  stabilized_approach:  'approach',
  landing:              'landing',
  taxi_in:              'taxi_in',
  post_flight:          'post_flight',
};

const PHASE_LABELS = {
  idle: 'Idle', preflight: 'Pre-Flight', pre_flight: 'Pre-Flight',
  taxi_out: 'Taxiing', taxi: 'Taxiing',
  takeoff_roll: 'Takeoff Roll', airborne: 'Airborne',
  climb: 'Climbing', cruise: 'Cruise', descent: 'Descending',
  approach: 'On Approach', stabilized_approach: 'Stabilized Appr',
  landing: 'Landing Roll', taxi_in: 'Taxi In', post_flight: 'Post-Flight',
};

// Grade color classes
const GRADE_COLORS = { 'A+': 'green', A: 'green', B: 'blue', C: 'yellow', D: 'orange', F: 'red' };

// ── Mutable state (IPC populates these; RAF reads them) ───────────────────────
const ipcState = {
  data:       null,   // latest flight data from main process
  phase:      'idle',
  hfData:     null,   // latest high-freq landing tick
  simStatus:  'disconnected',
  simMessage: '',
  pendingComplete: null,  // flightRecord awaiting user action
  pendingDebrief:  null,  // debrief from V5 scoring
  dirty: {
    data:      false,
    phase:     false,
    status:    false,
    complete:  false,
    debrief:   false,
  },
};

// Last-rendered values for dirty-check
const rendered = {
  alt: null, gs: null, hdg: null, vs: null, ias: null, fuel: null,
  gear: null, flaps: null, ap: null, lights: null,
  phase: null, conn: null, timer: null, coords: null,
  gradeBadge: null, phaseBadge: null,
};

// ── Timer state ───────────────────────────────────────────────────────────────
let takeoffMs       = null;
let timerInterval   = null;
let currentTimerStr = '—';

// ── Leaflet map state ─────────────────────────────────────────────────────────
let leafletMap     = null;
let planeMarker    = null;
let routePolyline  = null;
let depMarker      = null;
let mapVisible     = false;
let mapLastUpdateMs = 0;
const MAP_UPDATE_INTERVAL = 1000;  // update map at most 1 Hz
const routeLatLngs = [];           // growing array, capped at 500 points

// ── Route points buffer ───────────────────────────────────────────────────────
let lastRouteLat = null;
let lastRouteLon = null;

// ─────────────────────────────────────────────────────────────────────────────
// RAF loop — the only place DOM mutations happen
// ─────────────────────────────────────────────────────────────────────────────
function rafLoop() {
  requestAnimationFrame(rafLoop);

  if (ipcState.dirty.status) {
    ipcState.dirty.status = false;
    applySimStatus(ipcState.simStatus, ipcState.simMessage);
  }

  if (ipcState.dirty.phase) {
    ipcState.dirty.phase = false;
    applyPhase(ipcState.phase);
  }

  if (ipcState.dirty.data && ipcState.data) {
    ipcState.dirty.data = false;
    applyFlightData(ipcState.data);
  }

  if (ipcState.dirty.complete && ipcState.pendingComplete) {
    ipcState.dirty.complete = false;
    showDebrief(ipcState.pendingComplete, ipcState.pendingDebrief);
  }

  if (ipcState.dirty.debrief && ipcState.pendingDebrief) {
    ipcState.dirty.debrief = false;
    // Debrief arrived after complete — update grade display
    updateDebriefFromServer(ipcState.pendingDebrief);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM update functions — called only from inside the RAF loop
// ─────────────────────────────────────────────────────────────────────────────

function applySimStatus(status, message) {
  if (rendered.conn === status) return;
  rendered.conn = status;

  const dot   = $('conn-dot');
  const label = $('conn-label');
  const btn   = $('btn-connect');

  // Reset classes
  dot.className   = 'conn-dot';
  $('conn-status').className = '';

  switch (status) {
    case 'connected':
      $('conn-status').className = 'connected';
      dot.classList.add('connected');
      label.textContent  = 'Connected to MSFS';
      btn.textContent    = '⏹';
      btn.title          = 'Disconnect';
      btn.className      = 'title-action-btn connected';
      $('sync-spinner').style.display = 'block';
      $('status-text').textContent    = 'Connected — SimConnect active';
      break;
    case 'connecting':
      $('conn-status').className = 'connecting';
      dot.classList.add('connecting');
      label.textContent  = 'Connecting…';
      btn.textContent    = '✕';
      btn.title          = 'Cancel';
      btn.className      = 'title-action-btn';
      $('sync-spinner').style.display = 'block';
      $('status-text').textContent    = 'Connecting to Microsoft Flight Simulator…';
      break;
    case 'error':
      $('conn-status').className = 'error';
      dot.classList.add('error');
      label.textContent  = 'Connection Failed';
      btn.textContent    = '⚡';
      btn.title          = 'Retry';
      btn.className      = 'title-action-btn';
      $('sync-spinner').style.display = 'none';
      $('status-text').textContent    = message || 'MSFS not running';
      break;
    default:
      label.textContent  = 'Disconnected';
      btn.textContent    = '⚡';
      btn.title          = 'Connect to MSFS';
      btn.className      = 'title-action-btn';
      $('sync-spinner').style.display = 'none';
      $('status-text').textContent    = 'Not connected to MSFS';
  }
}

function applyPhase(phase) {
  if (rendered.phase === phase) return;
  rendered.phase = phase;

  const currentId  = PHASE_TO_ID[phase];
  const currentIdx = PHASE_ORDER.indexOf(currentId);

  PHASE_ORDER.forEach((phId, idx) => {
    const el = $(`ph-${phId}`);
    if (!el) return;
    el.classList.remove('completed', 'active');
    if (currentId && idx < currentIdx)  el.classList.add('completed');
    if (currentId && idx === currentIdx) el.classList.add('active');
  });

  // Phase badge
  const label = PHASE_LABELS[phase] || phase;
  setIfChanged('phase-badge', label, rendered, 'phaseBadge');
  $('phase-badge').className = `phase-badge ${phase}`;

  // Timer management
  if (['airborne', 'climb', 'cruise', 'descent', 'approach', 'stabilized_approach'].includes(phase)) {
    if (!takeoffMs) startTimer();
    $('status-text').textContent = label;
  } else if (phase === 'idle' || phase === 'preflight' || phase === 'pre_flight') {
    stopTimer();
    $('flight-timer').textContent = '—';
    if (phase === 'idle') $('status-text').textContent = 'Connected — waiting for flight';
  } else {
    $('status-text').textContent = label;
  }
}

function applyFlightData(d) {
  // Altitude
  const altStr = d.altitude.toLocaleString();
  if (rendered.alt !== altStr) {
    rendered.alt = altStr;
    $('d-alt').textContent = altStr;
  }

  // Ground speed
  const gsStr = String(d.groundSpeed);
  if (rendered.gs !== gsStr) {
    rendered.gs = gsStr;
    $('d-gs').textContent = gsStr;
  }

  // Heading
  const hdgStr = String(d.headingTrue ?? d.heading ?? 0).padStart(3, '0') + '°';
  if (rendered.hdg !== hdgStr) {
    rendered.hdg = hdgStr;
    $('d-hdg').textContent = hdgStr;
  }

  // Vertical speed (color coded)
  const vsStr   = (d.vs > 0 ? '+' : '') + d.vs.toLocaleString();
  const vsColor = d.vs > 0 ? '#6ee7b7' : d.vs < -1200 ? '#f87171' : d.vs < -400 ? '#fcd34d' : '#93c5fd';
  if (rendered.vs !== vsStr) {
    rendered.vs = vsStr;
    const el = $('d-vs');
    el.textContent  = vsStr;
    el.style.color  = vsColor;
  }

  // IAS
  const iasStr = String(d.ias);
  if (rendered.ias !== iasStr) {
    rendered.ias = iasStr;
    $('d-ias').textContent = iasStr;
  }

  // Fuel
  const fuelStr = Math.round(d.fuelGallons).toLocaleString();
  if (rendered.fuel !== fuelStr) {
    rendered.fuel = fuelStr;
    $('d-fuel').textContent = fuelStr;
  }

  // Systems strip
  const gearStr   = d.gearDown ? 'Gear↓' : 'Gear↑';
  const flapsStr  = d.flapsIndex > 0 ? `Flaps ${d.flapsIndex}` : 'Flaps Up';
  const apStr     = d.autopilot ? 'AP On' : 'AP Off';
  const lightsStr = buildLightsStr(d);

  if (rendered.gear !== gearStr) {
    rendered.gear = gearStr;
    $('sys-gear').textContent = gearStr;
    $('sys-gear').className = `sys-item${d.gearDown ? ' active' : ''}`;
  }
  if (rendered.flaps !== flapsStr) {
    rendered.flaps = flapsStr;
    $('sys-flaps').textContent = flapsStr;
    $('sys-flaps').className = `sys-item${d.flapsIndex > 0 ? ' active' : ''}`;
  }
  if (rendered.ap !== apStr) {
    rendered.ap = apStr;
    $('sys-ap').textContent = apStr;
    $('sys-ap').className = `sys-item${d.autopilot ? ' active' : ''}`;
  }
  if (rendered.lights !== lightsStr) {
    rendered.lights = lightsStr;
    $('sys-lights').textContent = lightsStr || 'Lights Off';
  }

  // Coordinates in status bar
  const coordStr = `${d.lat.toFixed(4)}° ${d.lon.toFixed(4)}°`;
  if (rendered.coords !== coordStr) {
    rendered.coords = coordStr;
    $('map-coords').textContent = coordStr;
  }

  // Accumulate route point for map (only when position changes significantly)
  const now = Date.now();
  if (mapVisible && now - mapLastUpdateMs > MAP_UPDATE_INTERVAL) {
    mapLastUpdateMs = now;
    updateMap(d);
  }

  if (lastRouteLat === null ||
      Math.abs(d.lat - lastRouteLat) > 0.005 ||
      Math.abs(d.lon - lastRouteLon) > 0.005) {
    lastRouteLat = d.lat;
    lastRouteLon = d.lon;
    routeLatLngs.push([d.lat, d.lon]);
    if (routeLatLngs.length > 500) routeLatLngs.shift();
  }
}

function buildLightsStr(d) {
  const on = [];
  if (d.lightBeacon)  on.push('BCN');
  if (d.lightNav)     on.push('NAV');
  if (d.lightStrobe)  on.push('STB');
  if (d.lightLanding) on.push('LDG');
  return on.join(' ');
}

function setIfChanged(id, value, cache, cacheKey) {
  if (cache[cacheKey] === value) return;
  cache[cacheKey] = value;
  $(id).textContent = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────────────────────
function startTimer() {
  if (takeoffMs) return;
  takeoffMs = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - takeoffMs;
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    const str = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    $('flight-timer').textContent = str;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  takeoffMs = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event log
// ─────────────────────────────────────────────────────────────────────────────
function addEvent(type, text) {
  const log = $('event-log');
  const placeholder = log.querySelector('.event-placeholder');
  if (placeholder) placeholder.remove();

  const icons = { takeoff: '🛫', landing: '🛬', complete: '✅', info: 'ℹ', error: '⚠' };

  const item = document.createElement('div');
  item.className = `event-item ${type}`;

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `<span class="evt-icon">${icons[type] ?? 'ℹ'}</span><span class="evt-text">${text}</span><span class="evt-time">${time}</span>`;
  log.insertBefore(item, log.firstChild);

  // Cap at 80 entries to avoid unbounded growth
  while (log.children.length > 80) log.removeChild(log.lastChild);
}

// ─────────────────────────────────────────────────────────────────────────────
// Debrief / flight complete
// ─────────────────────────────────────────────────────────────────────────────
function showDebrief(record, debrief) {
  const card = $('debrief-card');
  card.style.display = '';

  const dep = record.departure || '—';
  const arr = record.arrival   || '—';
  const lr  = record.landingRate ?? 0;
  const grade = debrief?.grade ?? record.grade ?? gradeFromLr(lr);

  $('db-route').textContent = `${dep} → ${arr}`;
  $('db-sub').textContent   = `${record.duration ?? 0} min · ${grade} grade`;

  $('db-grade').textContent  = grade;
  $('db-grade').className    = `debrief-grade grade-${grade.replace('+', 'plus')}`;

  $('db-lr').textContent     = `${lr > 0 ? '+' : ''}${lr} fpm`;
  $('db-gforce').textContent = `${(record.touchdownGForce ?? 0).toFixed(2)}G`;
  $('db-zone').textContent   = record.touchdownZoneHit ? '✓ In Zone' : '✗ Off Zone';
  $('db-bounce').textContent = String(record.bounceCount ?? 0);

  // Grade badge in flight card
  const gradeBadge = $('grade-badge');
  gradeBadge.style.display = '';
  gradeBadge.textContent   = grade;
  gradeBadge.className     = `grade-badge grade-${grade.replace('+', 'plus')}`;
}

function updateDebriefFromServer(debrief) {
  if (!debrief?.grade) return;
  const grade = debrief.grade;
  $('db-grade').textContent = grade;
  $('db-grade').className   = `debrief-grade grade-${grade.replace('+', 'plus')}`;
  $('db-sub').textContent   = `${$('db-sub').textContent.split('·')[0]}· ${grade} grade`;
}

function gradeFromLr(fpm) {
  const abs = Math.abs(fpm);
  if (abs < 100) return 'A+';
  if (abs < 200) return 'A';
  if (abs < 400) return 'B';
  if (abs < 600) return 'C';
  if (abs < 800) return 'D';
  return 'F';
}

// ─────────────────────────────────────────────────────────────────────────────
// Leaflet map
// ─────────────────────────────────────────────────────────────────────────────
function initMap() {
  if (typeof L === 'undefined') return;

  leafletMap = L.map('map', {
    center: [38, -98], zoom: 4,
    zoomControl: true, attributionControl: false,
  });

  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, keepBuffer: 1, updateWhenIdle: true }
  ).addTo(leafletMap);
}

function makePlaneIcon(heading) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="28" height="28"
    style="transform:rotate(${heading}deg);filter:drop-shadow(0 0 5px rgba(34,255,102,0.9));display:block">
    <path d="M20 2C18.5 2 17.5 4 17.5 7L17.5 15L4 22L4 25L17.5 21L17.5 32L13 35L13 37L20 35.5L27 37L27 35L22.5 32L22.5 21L36 25L36 22L22.5 15L22.5 7C22.5 4 21.5 2 20 2Z"
      fill="#22ff66" stroke="rgba(0,0,0,0.4)" stroke-width="0.8"/>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [28, 28], iconAnchor: [14, 14] });
}

function updateMap(d) {
  if (!leafletMap) return;
  const { lat, lon } = d;
  const icon = makePlaneIcon(d.headingTrue ?? d.heading ?? 0);

  if (planeMarker) {
    planeMarker.setLatLng([lat, lon]);
    planeMarker.setIcon(icon);
  } else {
    planeMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(leafletMap);
  }

  if (routeLatLngs.length > 1) {
    if (routePolyline) {
      routePolyline.setLatLngs(routeLatLngs);
    } else {
      routePolyline = L.polyline(routeLatLngs, {
        color: '#f48223', weight: 2, opacity: 0.7, dashArray: '8 5',
      }).addTo(leafletMap);
    }
  }

  leafletMap.panTo([lat, lon], { animate: true, duration: 0.4 });
}

function addDepMarker(lat, lon, icao) {
  if (!leafletMap) return;
  if (depMarker) leafletMap.removeLayer(depMarker);
  depMarker = L.circleMarker([lat, lon], {
    radius: 5, color: '#f48223', fillColor: '#f48223', fillOpacity: 0.9, weight: 1,
  }).bindTooltip(icao, { direction: 'bottom', offset: [0, 6] }).addTo(leafletMap);
}

function resetMap() {
  if (planeMarker)   { leafletMap?.removeLayer(planeMarker);   planeMarker   = null; }
  if (routePolyline) { leafletMap?.removeLayer(routePolyline); routePolyline = null; }
  if (depMarker)     { leafletMap?.removeLayer(depMarker);     depMarker     = null; }
  routeLatLngs.length = 0;
  lastRouteLat = lastRouteLon = null;
  if (leafletMap) leafletMap.setView([38, -98], 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings panel
// ─────────────────────────────────────────────────────────────────────────────
async function openSettings() {
  const s = window.tracker ? await window.tracker.loadSettings() : {};
  $('inp-api-url').value        = s.apiUrl || 'https://simcrewops.com';
  $('inp-api-token').value      = s.apiToken || '';
  $('chk-auto-connect').checked = !!s.autoConnect;
  $('chk-tray').checked         = !!s.minimizeToTray;
  $('verify-status').style.display = 'none';
  $('settings-overlay').classList.add('open');
}

function closeSettings() {
  $('settings-overlay').classList.remove('open');
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
  status.style.display = 'block';
  status.style.background = 'rgba(255,255,255,0.04)';
  status.style.color = 'rgba(255,255,255,0.5)';
  status.textContent = 'Verifying…';

  if (window.tracker) {
    await window.tracker.saveSettings({
      apiUrl:   $('inp-api-url').value.trim(),
      apiToken: $('inp-api-token').value.trim(),
    });
  }

  try {
    if (!window.tracker) throw new Error('Not running in Electron');
    await window.tracker.submitFlight({
      sessionDate: new Date().toISOString().split('T')[0],
      aircraft: 'TEST', duration: 1, simVersion: 'MSFS 2024',
    });
    status.style.background = 'rgba(74,222,128,0.1)';
    status.style.color      = '#34d399';
    status.textContent      = '✓ API key is valid';
  } catch (err) {
    const isAuth = err.message?.includes('token') || err.message?.includes('Unauthorized');
    status.style.background = isAuth ? 'rgba(248,113,113,0.1)' : 'rgba(250,204,21,0.1)';
    status.style.color      = isAuth ? '#f87171' : '#fcd34d';
    status.textContent      = isAuth ? '✗ Invalid API key' : `⚠ ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC event wiring (only inside Electron)
// ─────────────────────────────────────────────────────────────────────────────
if (window.tracker) {

  window.tracker.on('simconnect:status', ({ state: s, message }) => {
    ipcState.simStatus  = s;
    ipcState.simMessage = message || '';
    ipcState.dirty.status = true;

    if (s === 'connected') {
      addEvent('info', 'Connected to MSFS');
    } else if (s === 'disconnected') {
      addEvent('info', 'SimConnect disconnected');
      // Reset live data immediately
      ipcState.data  = null;
      ipcState.phase = 'idle';
      ipcState.dirty.phase = true;
      resetMap();
      routeLatLngs.length = 0;
      $('dep-icao').textContent = '—';
      $('arr-icao').textContent = '—';
      stopTimer();
    } else if (s === 'error') {
      addEvent('error', message || 'Connection error');
    }
  });

  window.tracker.on('flight:data', (data) => {
    if (!data) return;
    ipcState.data       = data;
    ipcState.dirty.data = true;
  });

  // High-freq landing data — only used for future live touchdown display
  // Stored but not rendered directly (low-priority)
  window.tracker.on('flight:hf', (lfd) => {
    ipcState.hfData = lfd;
  });

  window.tracker.on('flight:phase', ({ phase }) => {
    ipcState.phase       = phase;
    ipcState.dirty.phase = true;
  });

  window.tracker.on('flight:event', (event) => {
    if (event.type === 'takeoff') {
      const airport = event.airport || 'unknown';
      addEvent('takeoff', `Takeoff from ${airport} · IAS ${event.ias} kt`);
      $('dep-icao').textContent = airport;
      routeLatLngs.length = 0;
      if (ipcState.data) addDepMarker(ipcState.data.lat, ipcState.data.lon, airport);
      startTimer();
    } else if (event.type === 'landing') {
      const airport = event.airport || 'unknown';
      addEvent('landing',
        `Landed ${airport} · ${event.landingRate ?? '—'} fpm · ${event.gForce?.toFixed(2) ?? '—'}G`);
      $('arr-icao').textContent = airport;
      stopTimer();
    }
  });

  window.tracker.on('flight:complete', (record) => {
    ipcState.pendingComplete = record;
    ipcState.pendingDebrief  = null;  // Will be updated when debrief arrives
    ipcState.dirty.complete  = true;
    addEvent('complete', `Flight complete: ${record.departure ?? '?'} → ${record.arrival ?? '?'}`);
  });

  window.tracker.on('flight:debrief', ({ success, data }) => {
    if (success && data) {
      ipcState.pendingDebrief = data;
      ipcState.dirty.debrief  = true;
    }
  });

  window.tracker.on('api:submit', ({ success, error }) => {
    if (success) addEvent('complete', 'Flight submitted to SimCrewOps');
    else         addEvent('error', `Submit failed: ${error}`);
  });

} // end if (window.tracker)

// ─────────────────────────────────────────────────────────────────────────────
// Button handlers
// ─────────────────────────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', () => {
  if (!window.tracker) return;
  if (ipcState.simStatus === 'connected') {
    window.tracker.disconnect();
  } else {
    ipcState.simStatus  = 'connecting';
    ipcState.dirty.status = true;
    window.tracker.connect();
  }
});

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', closeSettings);
$('btn-settings-cancel').addEventListener('click', closeSettings);
$('btn-settings-save').addEventListener('click', saveSettings);
$('btn-verify-token').addEventListener('click', verifyToken);

$('link-api-key').addEventListener('click', (e) => {
  e.preventDefault();
  window.tracker?.openExternal('https://simcrewops.com/sim-tracker');
});

$('settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('settings-overlay')) closeSettings();
});

// Submit flight from debrief
$('btn-submit-flight').addEventListener('click', async () => {
  if (!ipcState.pendingComplete) return;
  const btn = $('btn-submit-flight');
  btn.disabled    = true;
  btn.textContent = 'Submitting…';
  const result = await window.tracker?.submitFlight(ipcState.pendingComplete);
  if (result?.success) {
    addEvent('complete', 'Flight logged in SimCrewOps');
    $('debrief-card').style.display = 'none';
    ipcState.pendingComplete = null;
  } else {
    btn.disabled    = false;
    btn.textContent = 'Submit to SimCrewOps';
    addEvent('error', `Submit failed: ${result?.error}`);
  }
});

$('btn-dismiss-debrief').addEventListener('click', () => {
  $('debrief-card').style.display = 'none';
  ipcState.pendingComplete = null;
});

// Map toggle
$('btn-map-toggle').addEventListener('click', () => {
  const wrapper = $('map-wrapper');
  mapVisible = wrapper.style.display === 'none';
  wrapper.style.display = mapVisible ? '' : 'none';
  if (mapVisible && leafletMap) {
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }
});

// Window controls (Electron only)
$('btn-minimize').addEventListener('click', () => window.tracker?.minimizeWindow());
$('btn-maximize').addEventListener('click', () => window.tracker?.maximizeWindow());
$('btn-close').addEventListener('click',    () => window.tracker?.closeWindow());

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  // macOS: hide custom window controls, shift for traffic lights
  if (navigator.platform.toLowerCase().includes('mac')) {
    document.body.classList.add('is-mac');
  }

  if (window.tracker) {
    const appState = await window.tracker.getState();
    if (appState.simConnected) {
      ipcState.simStatus    = 'connected';
      ipcState.dirty.status = true;
    }
    const version = await window.tracker.getVersion();
    $('version-tag').textContent = `v${version}`;
  }

  initMap();

  // Start the RAF loop — this is the sole driver of all DOM updates
  requestAnimationFrame(rafLoop);
}

init().catch(console.error);
