'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

app.allowRendererProcessReuse = true;

// ── Persistent settings ───────────────────────────────────────────────────────
const store = new Store({
  name: 'simcrewops-tracker',
  defaults: {
    apiUrl:         'https://simcrewops.com',
    apiToken:       '',
    autoConnect:    true,
    minimizeToTray: true,
    windowBounds:   { width: 900, height: 680 },
  },
});

// ── Module refs ───────────────────────────────────────────────────────────────
let SimConnectManager = null;
let FlightTracker     = null;
let ApiClient         = null;

let mainWindow     = null;
let tray           = null;
let simManager     = null;
let flightTracker  = null;
let apiClient      = null;
let isQuitting     = false;
let heartbeatInterval = null;

// ── IPC throttle state ────────────────────────────────────────────────────────
// Batches flight:data to the renderer at ≤5 Hz (every 200ms) so the renderer
// and the IPC bridge aren't flooded on every SimConnect tick.
let _pendingFlightData  = null;
let _ipcFlushTimer      = null;
const IPC_FLUSH_MS      = 200;   // max 5 UI updates per second

function scheduleIpcFlush() {
  if (_ipcFlushTimer) return;
  _ipcFlushTimer = setTimeout(() => {
    _ipcFlushTimer = null;
    if (_pendingFlightData !== null) {
      sendToRenderer('flight:data', _pendingFlightData);
      _pendingFlightData = null;
    }
  }, IPC_FLUSH_MS);
}

function cancelIpcFlush() {
  if (_ipcFlushTimer) {
    clearTimeout(_ipcFlushTimer);
    _ipcFlushTimer = null;
  }
  _pendingFlightData = null;
}

// ── Tray icon ─────────────────────────────────────────────────────────────────
function createTrayIcon(status = 'idle') {
  const colors = {
    idle:       '#64748b',
    connecting: '#f59e0b',
    connected:  '#10b981',
    tracking:   '#3b82f6',
    error:      '#ef4444',
  };
  const color = colors[status] || colors.idle;

  const { createCanvas } = (() => {
    try { return require('canvas'); } catch { return null; }
  })() || {};

  if (createCanvas) {
    const canvas = createCanvas(16, 16);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 16, 16);
    ctx.beginPath();
    ctx.arc(8, 8, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
  }

  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA' +
    'JklEQVQ4jWNgYGD4z8BQDwAAAP//AwBDAAEA8P8AAAD//wMAQwABAPD/AAAAA=='
  );
}

// ── Main window ───────────────────────────────────────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width:     bounds.width,
    height:    bounds.height,
    minWidth:  760,
    minHeight: 560,
    backgroundColor: '#0a0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame:     process.platform !== 'darwin',
    show:      false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (store.get('autoConnect') && simManager) {
      setTimeout(() => attemptSimConnect(), 1000);
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
  const icon = createTrayIcon('idle');
  tray = new Tray(icon);
  tray.setToolTip('SimCrewOps Tracker');
  updateTrayMenu('idle');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.focus();
      else mainWindow.show();
    }
  });
}

function updateTrayMenu(status) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'SimCrewOps Tracker', enabled: false },
    { label: `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setImage(createTrayIcon(status));
}

// ── IPC helpers ───────────────────────────────────────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function attemptSimConnect() {
  if (!simManager) return;
  sendToRenderer('simconnect:status', { state: 'connecting' });
  simManager.connect();
}

// ── SimConnect listener wiring ────────────────────────────────────────────────
function setupSimConnectListeners() {
  simManager.on('connected', (info) => {
    sendToRenderer('simconnect:status', { state: 'connected', info });
    updateTrayMenu('connected');
    // Pass engine count to tracker before starting
    // Engine count arrives in first data tick; set 2 as default initially
    flightTracker.setEngineCount(2);
    flightTracker.start();
  });

  simManager.on('disconnected', () => {
    cancelIpcFlush();
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

  // 1 Hz main data — process in tracker then batch-send to renderer
  simManager.on('data', (flightData) => {
    // Update engine count from first real data tick
    if (flightData.engineCount && flightData.engineCount !== flightTracker._engineCount) {
      flightTracker.setEngineCount(flightData.engineCount);
    }

    flightTracker.update(flightData);

    // Batch IPC update at ≤5 Hz
    _pendingFlightData = flightData;
    scheduleIpcFlush();
  });

  // High-frequency landing data (100ms, only during approach/landing)
  simManager.on('landingData', (lfd) => {
    flightTracker.processLandingTick(lfd);
    // Send HF data to renderer immediately (already 100ms throttled by SimConnect)
    sendToRenderer('flight:hf', lfd);
  });
}

// ── FlightTracker listener wiring ─────────────────────────────────────────────
function setupFlightTrackerListeners() {
  flightTracker.on('phase', (phaseEvent) => {
    sendToRenderer('flight:phase', phaseEvent);
    const p = phaseEvent.phase;
    if (p === 'climb' || p === 'cruise' || p === 'descent' || p === 'approach') {
      updateTrayMenu('tracking');
    } else if (p === 'idle' || p === 'preflight') {
      updateTrayMenu(simManager?.isConnected() ? 'connected' : 'idle');
    }
  });

  flightTracker.on('takeoff', (event) => {
    sendToRenderer('flight:event', { type: 'takeoff', ...event });
  });

  flightTracker.on('landing', (event) => {
    sendToRenderer('flight:event', { type: 'landing', ...event });
  });

  // High-freq mode toggle: tell SimConnect to start/stop 100ms polling
  flightTracker.on('highFreq', ({ enabled }) => {
    if (simManager?.isConnected()) {
      simManager.setHighFreqMode(enabled);
    }
  });

  flightTracker.on('flightComplete', async (flightRecord) => {
    // Send to renderer first so debrief shows immediately
    sendToRenderer('flight:complete', flightRecord);
    updateTrayMenu('connected');

    const token = store.get('apiToken');
    if (!token) return;

    // Try to score via V5 endpoint, fall back to standard submit
    try {
      const debrief = await apiClient.scoreFlight(flightRecord);
      sendToRenderer('flight:debrief', { success: true, data: debrief });
    } catch {
      // V5 scoring endpoint not available — fall back to legacy sim-session submit
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
    apiUrl:         store.get('apiUrl'),
    apiToken:       store.get('apiToken'),
    autoConnect:    store.get('autoConnect'),
    minimizeToTray: store.get('minimizeToTray'),
  }));

  ipcMain.handle('settings:save', (_, settings) => {
    if (settings.apiUrl)               store.set('apiUrl',   settings.apiUrl);
    if (settings.apiToken !== undefined) store.set('apiToken', settings.apiToken);
    if (settings.autoConnect !== undefined) store.set('autoConnect', settings.autoConnect);
    if (settings.minimizeToTray !== undefined) store.set('minimizeToTray', settings.minimizeToTray);
    if (apiClient) {
      apiClient.setBaseUrl(store.get('apiUrl'));
      apiClient.setToken(store.get('apiToken'));
    }
    return true;
  });

  ipcMain.handle('api:submitFlight', async (_, flightRecord) => {
    if (!apiClient) return { success: false, error: 'API client not initialized' };
    const token = store.get('apiToken');
    if (!token) return { success: false, error: 'No API token configured' };
    try {
      const result = await apiClient.submitFlight(flightRecord);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('open:external', (_, url) => shell.openExternal(url));

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:getState', () => ({
    simConnected:   simManager?.isConnected()  ?? false,
    trackingActive: flightTracker?.isTracking() ?? false,
    settings: {
      apiUrl:         store.get('apiUrl'),
      apiToken:       store.get('apiToken'),
      autoConnect:    store.get('autoConnect'),
      minimizeToTray: store.get('minimizeToTray'),
    },
  }));

  // Window controls (Windows custom titlebar)
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
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
    apiClient     = new ApiClient(store.get('apiUrl'), store.get('apiToken'));

    setupSimConnectListeners();
    setupFlightTrackerListeners();
  } catch (err) {
    console.error('Failed to load core modules:', err);
  }

  registerIpcHandlers();
  createWindow();
  createTray();

  // Heartbeat every 30s so the web app knows the tracker is online
  heartbeatInterval = setInterval(() => {
    if (apiClient && store.get('apiToken')) apiClient.sendHeartbeat();
  }, 30_000);
  if (apiClient && store.get('apiToken')) apiClient.sendHeartbeat();
});

app.on('window-all-closed', () => {
  // Stay alive in tray — don't quit
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => {
  isQuitting = true;
  cancelIpcFlush();
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (simManager)    simManager.disconnect();
  if (flightTracker) flightTracker.stop();
});

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
