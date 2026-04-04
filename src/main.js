'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');

// Allow requiring native modules packaged with app
app.allowRendererProcessReuse = true;

// ── Persistent settings store ─────────────────────────────────────────────────
const store = new Store({
  name: 'simcrewops-tracker',
  defaults: {
    apiUrl: 'https://simcrewops.com',
    apiToken: '',
    autoConnect: true,
    minimizeToTray: true,
    windowBounds: { width: 900, height: 680 },
  },
});

// ── Module imports (after app path is set) ────────────────────────────────────
let SimConnectManager = null;
let FlightTracker = null;
let ApiClient = null;

let mainWindow = null;
let tray = null;
let simManager = null;
let flightTracker = null;
let apiClient = null;
let isQuitting = false;
let heartbeatInterval = null;

// ── Create tray icon programmatically ─────────────────────────────────────────
function createTrayIcon(status = 'idle') {
  // 16x16 PNG generated as a data URL based on status
  const colors = {
    idle:        '#64748b',
    connecting:  '#f59e0b',
    connected:   '#10b981',
    tracking:    '#3b82f6',
    error:       '#ef4444',
  };
  const color = colors[status] || colors.idle;

  // Use Electron nativeImage to create a simple colored circle icon
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

  // Fallback: hard-coded 1x1 pixel image
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA' +
    'JklEQVQ4jWNgYGD4z8BQDwAAAP//AwBDAAEA8P8AAAD//wMAQwABAPD/AAAAA=='
  );
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0a0f1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Auto-connect if enabled
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

// ── Create system tray ────────────────────────────────────────────────────────
function createTray() {
  const icon = createTrayIcon('idle');
  tray = new Tray(icon);
  tray.setToolTip('SimCrewOps Tracker');

  updateTrayMenu('idle');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
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
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  const icon = createTrayIcon(status);
  tray.setImage(icon);
}

// ── SimConnect connection management ──────────────────────────────────────────
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
    flightTracker.update(flightData);
    sendToRenderer('flight:data', flightData);
  });
}

function setupFlightTrackerListeners() {
  flightTracker.on('phase', (phase) => {
    sendToRenderer('flight:phase', phase);
    if (phase.phase === 'tracking' || phase.phase === 'cruise') {
      updateTrayMenu('tracking');
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

    // Auto-submit if token is configured
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
  // SimConnect control
  ipcMain.on('simconnect:connect', () => attemptSimConnect());
  ipcMain.on('simconnect:disconnect', () => {
    if (simManager) simManager.disconnect();
  });

  // Tracking control
  ipcMain.on('tracking:start', () => {
    if (flightTracker) flightTracker.startTracking();
  });
  ipcMain.on('tracking:stop', () => {
    if (flightTracker) flightTracker.stopTracking();
  });

  // Settings
  ipcMain.handle('settings:load', () => ({
    apiUrl: store.get('apiUrl'),
    apiToken: store.get('apiToken'),
    autoConnect: store.get('autoConnect'),
    minimizeToTray: store.get('minimizeToTray'),
  }));

  ipcMain.handle('settings:save', (_, settings) => {
    if (settings.apiUrl)   store.set('apiUrl', settings.apiUrl);
    if (settings.apiToken !== undefined) store.set('apiToken', settings.apiToken);
    if (settings.autoConnect !== undefined) store.set('autoConnect', settings.autoConnect);
    if (settings.minimizeToTray !== undefined) store.set('minimizeToTray', settings.minimizeToTray);

    // Update api client
    if (apiClient) {
      apiClient.setBaseUrl(store.get('apiUrl'));
      apiClient.setToken(store.get('apiToken'));
    }
    return true;
  });

  // Manual flight submit
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

  // Open external links
  ipcMain.on('open:external', (_, url) => shell.openExternal(url));

  // App info
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:getState', () => ({
    simConnected: simManager?.isConnected() ?? false,
    trackingActive: flightTracker?.isTracking() ?? false,
    settings: {
      apiUrl: store.get('apiUrl'),
      apiToken: store.get('apiToken'),
      autoConnect: store.get('autoConnect'),
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
  // Lazy-load modules (they may require native modules)
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

  // Send a heartbeat to the web app every 30 s so the Sim Tracker page can
  // show a real "connected" status instead of always showing "disconnected".
  heartbeatInterval = setInterval(() => {
    if (apiClient && store.get('apiToken')) {
      apiClient.sendHeartbeat();
    }
  }, 30_000);
  // Also send one immediately on startup so the status updates right away.
  if (apiClient && store.get('apiToken')) {
    apiClient.sendHeartbeat();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit — we live in the tray
  }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (simManager) simManager.disconnect();
});

// Prevent multiple instances
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
