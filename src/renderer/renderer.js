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

// ── Mapbox map state ───────────────────────────────────────────────────────
let mbMap       = null;   // mapboxgl.Map instance
let planeMarker = null;   // mapboxgl.Marker for the aircraft
let mapReady    = false;  // true after map 'load' event fires

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const btnConnect        = $('btn-connect');
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

// ── Mapbox GL map ──────────────────────────────────────────────────────────

/** Build or update the DOM element used by the mapboxgl.Marker for the aircraft. */
function makePlaneElement(sizePx, rotationDeg) {
  const el = document.createElement('div');
  el.style.cssText = `width:${sizePx}px;height:${sizePx}px;pointer-events:none;`;
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"
      width="${sizePx}" height="${sizePx}"
      style="transform:rotate(${rotationDeg}deg);
             filter:drop-shadow(0 0 6px rgba(34,255,102,0.9));
             display:block;transition:transform 0.4s ease;">
    <g fill="#22ff66" stroke="rgba(0,0,0,0.4)" stroke-width="0.8">
      <path d="M20 2 C18.5 2 17.5 4 17.5 7 L17.5 15 L4 22 L4 25 L17.5 21
               L17.5 32 L13 35 L13 37 L20 35.5 L27 37 L27 35 L22.5 32
               L22.5 21 L36 25 L36 22 L22.5 15 L22.5 7 C22.5 4 21.5 2 20 2Z"/>
    </g>
  </svg>`;
  return el;
}

function updatePlaneRotation(markerEl, rotationDeg) {
  const svg = markerEl.querySelector('svg');
  if (svg) svg.style.transform = `rotate(${rotationDeg}deg)`;
}

function initMap(mapboxToken) {
  if (!mapboxToken) {
    console.warn('[tracker] No Mapbox token — map disabled. Add one in Settings.');
    return;
  }
  if (typeof mapboxgl === 'undefined') {
    console.warn('[tracker] mapbox-gl not loaded — map disabled');
    return;
  }

  mapboxgl.accessToken = mapboxToken;

  mbMap = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: [-98, 38],
    zoom: 3,
    attributionControl: false,
    logoPosition: 'bottom-right',
  });

  mbMap.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  mbMap.on('load', () => {
    mapReady = true;

    // ── Route line ──────────────────────────────────────────────────────────
    mbMap.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    });
    mbMap.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#f48223',
        'line-width': 2.5,
        'line-opacity': 0.8,
        'line-dasharray': [2, 1.5],
      },
    });

    // ── Departure marker ────────────────────────────────────────────────────
    mbMap.addSource('dep-marker', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    mbMap.addLayer({
      id: 'dep-circle',
      type: 'circle',
      source: 'dep-marker',
      paint: {
        'circle-radius': 6,
        'circle-color': '#f48223',
        'circle-opacity': 0.9,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#fff',
      },
    });
  });
}

function updateMap(data) {
  if (!mbMap || !mapReady || !data) return;

  const { lat, lon, heading } = data;
  const lngLat = [lon, lat];

  if (!planeMarker) {
    const el = makePlaneElement(32, heading ?? 0);
    planeMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(mbMap);
  } else {
    planeMarker.setLngLat(lngLat);
    updatePlaneRotation(planeMarker.getElement(), heading ?? 0);
  }

  // Update route line
  if (state.routePoints.length > 1) {
    mbMap.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: state.routePoints.map(p => [p.lon, p.lat]) },
    });
  }

  mbMap.panTo(lngLat, { duration: 500 });
}

function addDepMarker(lat, lon, icao) {
  if (!mbMap || !mapReady) return;
  mbMap.getSource('dep-marker').setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { icao },
    }],
  });
}

function resetMap() {
  if (!mbMap || !mapReady) return;
  if (planeMarker) { planeMarker.remove(); planeMarker = null; }
  mbMap.getSource('route')?.setData(
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
  );
  mbMap.getSource('dep-marker')?.setData({ type: 'FeatureCollection', features: [] });
  mbMap.flyTo({ center: [-98, 38], zoom: 3, duration: 800 });
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
      state.simConnected = false;
      $('sync-spinner').style.display = 'none';
      $('status-text').textContent = message || 'MSFS not running or SimConnect unavailable';
      break;

    default: // disconnected
      connLabel.textContent = 'Disconnected';
      btnConnect.textContent = '⚡';
      btnConnect.title       = 'Connect to MSFS';
      btnConnect.className   = 'title-action-btn';
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

// ── Next flight briefing ───────────────────────────────────────────────────
function applyFlightBriefing(flight) {
  if (!flight) return;
  // Only populate when idle — don't overwrite an in-progress flight
  if (state.phase && state.phase !== 'idle') return;

  const setText = (id, val) => { const el = $(id); if (el && val) el.textContent = val; };

  // Flight number and airline prefix
  const fn = flight.flightNumber || flight.flight_number || flight.callsign || '';
  if (fn) {
    setText('flight-num', fn);
    // Extract airline code: first 2-3 alpha chars before any digit
    const match = fn.match(/^([A-Z]{2,3})\d/);
    if (match) setText('airline-badge', match[1]);
  }

  // Airports
  const dep = flight.departure || flight.departureIcao || flight.origin || '';
  const arr = flight.arrival   || flight.arrivalIcao   || flight.destination || '';
  setText('dep-icao',  dep.toUpperCase());
  setText('arr-icao',  arr.toUpperCase());

  // Aircraft
  const ac = flight.aircraft || flight.aircraftType || flight.aircraft_type || '';
  setText('aircraft-tag', ac);

  // Phase badge → "Scheduled"
  const badge = $('phase-badge');
  if (badge) {
    badge.textContent = 'Scheduled';
    badge.style.background = 'rgba(59,130,246,0.15)';
    badge.style.color      = '#60a5fa';
    badge.style.border     = '1px solid rgba(59,130,246,0.3)';
  }

  // Show scheduled departure time in the timer field
  const depTime = flight.scheduledDeparture || flight.scheduled_departure || flight.departureTime || '';
  if (depTime) {
    const d = new Date(depTime);
    if (!isNaN(d)) {
      setText('flight-timer', `STD ${d.toUTCString().slice(17, 22)}Z`);
    }
  }
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
  $('inp-api-url').value        = s.apiUrl      || 'https://simcrewops.com';
  $('inp-mapbox-token').value   = s.mapboxToken || '';
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
    mapboxToken:    $('inp-mapbox-token').value.trim(),
    autoConnect:    $('chk-auto-connect').checked,
    minimizeToTray: $('chk-tray').checked,
  };
  if (window.tracker) await window.tracker.saveSettings(settings);
  closeSettings();
  addEvent('info', 'Settings saved — restart the app to apply map changes');
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

  // Recalculate map size when the map tab becomes visible
  if (name === 'myflight' && mbMap) {
    setTimeout(() => mbMap.resize(), 50);
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

window.tracker.on('flight:briefing', (flight) => {
  applyFlightBriefing(flight);
});

window.tracker.on('auth:stateChanged', (auth) => {
  applyAuthState(auth);
  if (auth.isSignedIn && auth.user) {
    const name = auth.user.name || auth.user.email || 'user';
    addEvent('info', `Signed in as ${name}`);
    // Fetch next scheduled flight now that we have a session
    window.tracker.getNextFlight().then(({ data }) => {
      if (data) applyFlightBriefing(data);
    }).catch(() => {});
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

// ── Bottom tabs (ACARS | Live Map) ────────────────────────────────────────
(function () {
  const tabs  = document.querySelectorAll('.btab');
  const panes = document.querySelectorAll('.btab-pane');

  function switchBtab(name) {
    tabs.forEach(t  => t.classList.toggle('active', t.dataset.btab === name));
    panes.forEach(p => p.classList.toggle('active', p.id === 'btab-' + name));
    if (name === 'map' && mbMap) setTimeout(() => mbMap.resize(), 50);
  }

  tabs.forEach(tab => tab.addEventListener('click', () => switchBtab(tab.dataset.btab)));

  // Status-bar map button now jumps to the Live Map tab
  const btnMapToggle = $('btn-map-toggle');
  if (btnMapToggle) {
    btnMapToggle.addEventListener('click', () => switchBtab('map'));
  }
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

    // Pre-populate the flight card with the next scheduled flight (if signed in)
    if (appState.auth && appState.auth.isSignedIn) {
      window.tracker.getNextFlight().then(({ data }) => {
        if (data) applyFlightBriefing(data);
      }).catch(() => {});
    }

    // Version
    const version = await window.tracker.getVersion();
    versionTag.textContent = `v${version}`;
  }

  // Init Mapbox map — token comes from persisted settings
  const mapboxToken = window.tracker
    ? (await window.tracker.loadSettings()).mapboxToken || ''
    : '';
  initMap(mapboxToken);
}

init().catch(console.error);
