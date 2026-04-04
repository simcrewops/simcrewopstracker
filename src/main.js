'use strict';

// ── Disable GPU before anything else — saves ~50MB VRAM while MSFS is running
app.disableHardwareAcceleration();

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

app.allowRendererProcessReuse = true;

// ── Persistent settings store ─────────────────────────────────────────────────
const store = new Store({
  name: 'simcrewops-tracker',
  defaults: {
    apiUrl:          'https://simcrewops.com',
    apiToken:        '',
    autoConnect:     true,
    minimizeToTray:  true,
    performanceMode: false,
    windowBounds:    { width: 860, height: 640 },
  },
});

// ── Module imports ────────────────────────────────────────────────────────────
let SimConnectManager = null;
let FlightTracker     = null;
let ApiClient         = null;

let mainWindow    = null;
let tray          = null;
let simManager    = null;
let flightTracker = null;
let apiClient     = null;
let isQuitting    = false;

// ── Tray icon (pre-built data URLs per state, zero runtime cost) ──────────────
// 16×16 SVG-in-PNG encoded as minimal data URLs for each status colour.
// Avoids any canvas dependency.
const TRAY_ICONS = {
  idle:       '#64748b',
  connecting: '#f59e0b',
  connected:  '#10b981',
  tracking:   '#3b82f6',
  error:      '#ef4444',
};

function createTrayIcon(status) {
  const fill = TRAY_ICONS[status] || TRAY_ICONS.idle;
  // Build a tiny SVG and convert to nativeImage
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
    `<circle cx="8" cy="8" r="7" fill="${fill}"/>` +
    `</svg>`
  );
  return nativeImage.createFromBuffer(svg, { scaleFactor: 1 });
}

// ── Per-phase UI update throttle (ms) ────────────────────────────────────────
// Only send data to the renderer this often per phase.
// The state machine in flight-tracker.js still runs every SimConnect tick.
const PHASE_UI_MS = {
  idle:          5000,
  pre_flight:    4000,
  taxi:          2000,
  takeoff_roll:  1000,
  airborne:      1000,
  climb:         2500,
  cruise:        3000,
  descent:       2500,
  approach:      1000,
  landing:       1000,
  post_flight:   5000,
};

let _currentPhase  = 'idle';
let _lastUiSendMs  = 0;
let _pendingData   = null;   // latest frame; sent to renderer at next allowed tick

function getUiIntervalMs() {
  const base = PHASE_UI_MS[_currentPhase] ?? 3000;
  return store.get('performanceMode') ? Math.max(5000, base * 2) : base;
}

// ── Send to renderer (throttled for data frames) ──────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

function maybeSendData(data) {
  _pendingData = data;
  const now = Date.now();
  if (now - _lastUiSendMs < getUiIntervalMs()) return;
  _lastUiSendMs = now;
  sendToRenderer('flight:data', data);
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width:     bounds.width,
    height:    bounds.height,
    minWidth:  720,
    minHeight: 520,
    backgroundColor: '#0a0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    show: false,
    webPreferences: {
      preload:                 path.join(__dirname, 'preload.js'),
      contextIsolation:        true,
      nodeIntegration:         false,
      nodeIntegrationInWorker: false,
      sandbox:                 false,
      backgroundThrottling:    true,   // throttle timers when window is hidden
      spellcheck:              false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (store.get('autoConnect') && simManager) {
      setTimeout(() => attemptSimConnect(), 1200);
    }
  });

  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    store.set('windowBounds', { width, height });
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(createTrayIcon('idle'));
  tray.setToolTip('SimCrewOps Tracker');
  updateTrayMenu('idle');
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
}

function updateTrayMenu(status) {
  if (!tray) return;
  tray.setImage(createTrayIcon(status));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'SimCrewOps Tracker', enabled: false },
    { label: `${status.charAt(0).toUpperCase()}${status.slice(1)}`, enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ── SimConnect + FlightTracker wiring ─────────────────────────────────────────
function attemptSimConnect() {
  if (!simManager) return;
  sendToRenderer('simconnect:status', { state: 'connecting' });
  simManager.connect();
}

function setupSimConnectListeners() {
  simManager.on('connected', (info) => {
    sendToRenderer('simconnect:status', { state: 'connected', info });
    updateTrayMenu('connected');
    flightTracker.start();
  });

  simManager.on('disconnected', () => {
    sendToRenderer('simconnect:status', { state: 'disconnected' });
    updateTrayMenu('idle');
    flightTracker.stop();
    sendToRenderer('flight:data', null);
    sendToRenderer('flight:phase', { phase: 'idle' });
  });

  simManager.on('error', (err) => {
    sendToRenderer('simconnect:status', { state: 'error', message: err.message });
    updateTrayMenu('error');
  });

  simManager.on('data', (flightData) => {
    // State machine always runs — accuracy requires every frame.
    flightTracker.update(flightData);
    // UI updates are throttled by phase to save IPC + renderer CPU.
    maybeSendData(flightData);
  });
}

function setupFlightTrackerListeners() {
  flightTracker.on('phase', ({ phase, prev, pollSecs }) => {
    _currentPhase = phase;

    // Tell SimConnect to poll at the rate appropriate for this phase
    if (simManager && pollSecs) simManager.setPollingInterval(pollSecs);

    // Flush pending data immediately on phase transitions
    if (_pendingData) {
      _lastUiSendMs = 0;
      maybeSendData(_pendingData);
    }

    sendToRenderer('flight:phase', { phase, prev });

    if (['climb', 'cruise', 'descent', 'airborne'].includes(phase)) {
      updateTrayMenu('tracking');
    } else if (phase === 'idle' || phase === 'pre_flight') {
      updateTrayMenu('connected');
    }
  });

  flightTracker.on('takeoff', (event) => {
    sendToRenderer('flight:event', { type: 'takeoff', ...event });
  });

  flightTracker.on('landing', (event) => {
    sendToRenderer('flight:event', { type: 'landing', ...event });
  });

  flightTracker.on('flightComplete', async (flightRecord) => {
    sendToRenderer('flight:complete', flightRecord);
    updateTrayMenu('connected');
    _currentPhase = 'pre_flight';

    const token = store.get('apiToken');
    if (token) {
      try {
        const result = await apiClient.submitFlight(flightRecord);
        sendToRenderer('api:submit', { success: true, data: result });
      } catch (err) {
        sendToRenderer('api:submit', { success: false, error: err.message });
      }
    }
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  ipcMain.on('simconnect:connect',    () => attemptSimConnect());
  ipcMain.on('simconnect:disconnect', () => simManager?.disconnect());

  ipcMain.on('tracking:start', () => flightTracker?.startTracking());
  ipcMain.on('tracking:stop',  () => flightTracker?.stopTracking());

  ipcMain.handle('settings:load', () => ({
    apiUrl:          store.get('apiUrl'),
    apiToken:        store.get('apiToken'),
    autoConnect:     store.get('autoConnect'),
    minimizeToTray:  store.get('minimizeToTray'),
    performanceMode: store.get('performanceMode'),
  }));

  ipcMain.handle('settings:save', (_, s) => {
    if (s.apiUrl          !== undefined) store.set('apiUrl',          s.apiUrl);
    if (s.apiToken        !== undefined) store.set('apiToken',        s.apiToken);
    if (s.autoConnect     !== undefined) store.set('autoConnect',     s.autoConnect);
    if (s.minimizeToTray  !== undefined) store.set('minimizeToTray',  s.minimizeToTray);
    if (s.performanceMode !== undefined) {
      store.set('performanceMode', s.performanceMode);
      flightTracker?.setPerformanceMode(s.performanceMode);
    }
    apiClient?.setBaseUrl(store.get('apiUrl'));
    apiClient?.setToken(store.get('apiToken'));
    return true;
  });

  ipcMain.handle('api:submitFlight', async (_, record) => {
    if (!store.get('apiToken')) return { success: false, error: 'No API token configured' };
    try {
      return { success: true, data: await apiClient.submitFlight(record) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('open:external', (_, url) => shell.openExternal(url));

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:getState', () => ({
    simConnected:    simManager?.isConnected()   ?? false,
    trackingActive:  flightTracker?.isTracking() ?? false,
    settings: {
      apiUrl:          store.get('apiUrl'),
      apiToken:        store.get('apiToken'),
      autoConnect:     store.get('autoConnect'),
      minimizeToTray:  store.get('minimizeToTray'),
      performanceMode: store.get('performanceMode'),
    },
  }));

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => {
    if (store.get('minimizeToTray')) mainWindow?.hide();
    else { isQuitting = true; app.quit(); }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.on('ready', async () => {
  try {
    SimConnectManager = require('./simconnect');
    FlightTracker     = require('./flight-tracker');
    ApiClient         = require('./api-client');

    simManager    = new SimConnectManager();
    flightTracker = new FlightTracker();
    flightTracker.setPerformanceMode(store.get('performanceMode'));
    apiClient     = new ApiClient(store.get('apiUrl'), store.get('apiToken'));

    setupSimConnectListeners();
    setupFlightTrackerListeners();
  } catch (err) {
    console.error('Failed to load core modules:', err);
  }

  registerIpcHandlers();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('activate', () => mainWindow?.show());
app.on('before-quit', () => { isQuitting = true; simManager?.disconnect(); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.restore?.(); mainWindow.show(); mainWindow.focus(); }
  });
}
