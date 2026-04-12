'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { exec } = require('child_process');
const Store = require('electron-store');

// ── Persistent settings store ─────────────────────────────────────────────────
const store = new Store({
  name: 'simcrewops-tracker',
  defaults: {
    apiUrl: 'https://simcrewops.com',
    autoConnect: true,
    minimizeToTray: true,
    mapboxToken: (() => { try { return require('./config').mapboxToken; } catch { return ''; } })(),
    windowBounds: { width: 900, height: 680 },
    userInfo: null,
  },
});

// ── Module imports (after app path is set) ────────────────────────────────────
let SimConnectManager = null;
let FlightTracker = null;
let ApiClient = null;

let mainWindow = null;
let authWindow = null;
let tray = null;
let simManager = null;
let flightTracker = null;
let apiClient = null;
let isQuitting = false;
let heartbeatInterval = null;
let lastFlightData = null;   // kept current for live-map heartbeat payloads
let _simStartCheckDone = false; // true after first data frame is inspected for mid-flight resume
let lastDataAt = 0;
let dataWatchdog = null;

// ── Auth state ────────────────────────────────────────────────────────────────
let authState = {
  isSignedIn: false,
  user: null,
};

// ── Get a fresh Clerk session token from the hidden auth window ───────────────
async function getClerkToken() {
  if (!authWindow || authWindow.isDestroyed()) return null;
  try {
    const token = await authWindow.webContents.executeJavaScript(
      'window.Clerk && window.Clerk.session ? window.Clerk.session.getToken() : null'
    );
    return token || null;
  } catch {
    return null;
  }
}

// ── Capture signed-in user info from the auth window ─────────────────────────
// emitOnFailure: when false, a missing session is silent (used during retries
// so the renderer does NOT see repeated "Signed out" events while Clerk boots).
async function captureAuthState(emitOnFailure = true) {
  if (!authWindow || authWindow.isDestroyed()) return;
  try {
    const result = await authWindow.webContents.executeJavaScript(`
      (async () => {
        if (!window.Clerk || !window.Clerk.session) return null;
        const token = await window.Clerk.session.getToken();
        const user  = window.Clerk.user;
        if (!token || !user) return null;
        return {
          token,
          user: {
            id:       user.id,
            email:    user.primaryEmailAddress?.emailAddress ?? '',
            name:     user.fullName || (user.firstName ? (user.firstName + ' ' + (user.lastName || '')).trim() : ''),
            username: user.username ?? '',
          },
        };
      })()
    `);

    if (result && result.user) {
      authState = { isSignedIn: true, user: result.user };
      store.set('userInfo', result.user);
      sendToRenderer('auth:stateChanged', authState);
      // Fire a heartbeat immediately so the live map comes online without
      // waiting up to 30 s for the next scheduled interval tick.
      if (apiClient) apiClient.sendHeartbeat(lastFlightData);
    } else if (emitOnFailure) {
      // Only emit signed-out once — not on every silent retry attempt.
      authState = { isSignedIn: false, user: null };
      store.set('userInfo', null);
      sendToRenderer('auth:stateChanged', authState);
    }
  } catch (err) {
    console.error('[auth] Failed to capture auth state:', err.message);
  }
}

// ── Create the hidden auth window that holds the Clerk session ────────────────
async function createAuthWindow() {
  if (authWindow && !authWindow.isDestroyed()) return;

  authWindow = new BrowserWindow({
    width: 520,
    height: 680,
    show: false,
    title: 'SimCrewOps — Sign In',
    backgroundColor: '#0a0f1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Named persistent partition so Clerk cookies/localStorage survive restarts
      partition: 'persist:clerk',
    },
  });

  // Prevent navigation away from the web app domain
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // When the user finishes signing in, Clerk redirects to the dashboard.
  // We detect that, capture the session, then hide the window.
  // Pass emitSignedOut=false: on the navigate event Clerk may not be fully
  // initialised yet, so a failed capture should not wipe the persisted session.
  // The did-finish-load retry loop owns the final signed-out decision.
  authWindow.webContents.on('did-navigate', async (_, url) => {
    const isAuthPage = url.includes('/sign-in') || url.includes('/sign-up') ||
                       url.includes('/login')   || url.includes('/register');
    if (!isAuthPage) {
      await captureAuthState(false);
      if (authState.isSignedIn && authWindow && !authWindow.isDestroyed()) {
        authWindow.hide();
      }
    }
  });

  // Retry capturing auth state after load — Clerk needs a moment to bootstrap
  // its session from cookies/localStorage before window.Clerk.session is ready.
  // Retries are SILENT (emitOnFailure=false) so the renderer never sees repeated
  // "Signed out" events. Only the final attempt emits a signed-out if needed.
  authWindow.webContents.on('did-finish-load', () => {
    let attempts = 0;
    const maxAttempts = 10;
    const tryCapture = async () => {
      attempts++;
      const isLast = attempts >= maxAttempts;
      await captureAuthState(isLast);   // emit signed-out only on last attempt
      if (!authState.isSignedIn && !isLast) {
        setTimeout(tryCapture, 500);
      }
    };
    setTimeout(tryCapture, 500);
  });

  authWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      authWindow.hide();
    }
  });

  const webAppUrl = store.get('apiUrl', 'https://simcrewops.com');
  await authWindow.loadURL(webAppUrl).catch(() => {});
}

// ── Tray icon (real logo, 16×16) ──────────────────────────────────────────────
function createTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(iconPath);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
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
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (store.get('autoConnect') && simManager) {
      // 3-second delay gives MSFS 2024 time to finish loading SimConnect
      // before the first open() attempt (1s was too short).
      setTimeout(() => attemptSimConnect(), 3000);
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
  const icon = createTrayIcon();
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
}

// ── SimConnect.cfg writer (TCP mode for MSFS Store sandboxing fix) ────────────
// Writes SimConnect.cfg to all known MSFS config locations so the sim opens a
// TCP listener on port 500.  This bypasses the named-pipe sandboxing that the
// Microsoft Store edition of MSFS 2024 applies to non-Store apps.
// Failures are silent — users without all three installs will hit missing dirs.
function writeSimConnectCfg() {
  if (process.platform !== 'win32') return;

  const cfgContent = [
    '[SimConnect]',
    'Protocol=IPv4',
    'Address=127.0.0.1',
    'Port=500',
    'MaxReceiveSize=4096',
    'DisableNagle=0',
  ].join('\r\n') + '\r\n';

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData      = process.env.APPDATA      || path.join(os.homedir(), 'AppData', 'Roaming');

  const cfgPaths = [
    // MSFS 2024 — Microsoft Store (Store sandbox, confirmed install type)
    path.join(localAppData, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'SimConnect.cfg'),
    // MSFS 2024 — Steam
    path.join(appData, 'Microsoft Flight Simulator 2024', 'SimConnect.cfg'),
    // MSFS 2020 — Steam (fallback for users on 2020)
    path.join(appData, 'Microsoft Flight Simulator', 'SimConnect.cfg'),
  ];

  for (const cfgPath of cfgPaths) {
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, cfgContent, 'utf8');
      console.log(`[SimConnect] Wrote TCP cfg → ${cfgPath}`);
    } catch (err) {
      console.warn(`[SimConnect] Could not write cfg to ${cfgPath}: ${err.message}`);
    }
  }
}

// ── MSFS process detection ────────────────────────────────────────────────────
// Both MSFS 2020 and MSFS 2024 (Store + Steam) run as FlightSimulator.exe.
function isMsfsRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(true); // can't check on non-Windows; let the connect attempt proceed
      return;
    }
    exec('tasklist /FI "IMAGENAME eq FlightSimulator.exe" /NH', (err, stdout) => {
      if (err) {
        resolve(true); // tasklist failed — don't block the connect attempt
        return;
      }
      resolve(stdout.toLowerCase().includes('flightsimulator.exe'));
    });
  });
}

// ── SimConnect connection management ──────────────────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

async function attemptSimConnect() {
  if (!simManager) return;

  // Write SimConnect.cfg to all MSFS config locations so the sim opens a TCP
  // listener on port 500 (bypasses Store named-pipe sandbox for MSFS 2024).
  writeSimConnectCfg();

  // Check MSFS is actually running before attempting the connection so the
  // user sees a clear "launch MSFS first" message instead of ECONNREFUSED.
  const msfsUp = await isMsfsRunning();
  if (!msfsUp) {
    sendToRenderer('simconnect:status', {
      state:   'error',
      message: 'MSFS not detected — launch Microsoft Flight Simulator first, then click Connect.',
    });
    sendToRenderer('flight:event', {
      type:    'notice',
      message: 'MSFS not detected. Start MSFS 2024, load a flight, then click Connect.',
    });
    return;
  }

  sendToRenderer('simconnect:status', { state: 'connecting' });
  simManager.connect();
}

function setupSimConnectListeners() {
  simManager.on('connected', (info) => {
    sendToRenderer('simconnect:status', { state: 'connected', info });
    updateTrayMenu('connected');
    // Don't start the tracker yet — wait for the first data frame so we can
    // detect a mid-flight restart before committing to PRE_FLIGHT.
    _simStartCheckDone = false;
    lastDataAt = Date.now();
    dataWatchdog = setInterval(() => {
      if (Date.now() - lastDataAt > 10_000) {
        console.warn('[Tracker] No SimConnect data for 10s — sim may be paused or frozen');
        sendToRenderer('simconnect:status', { state: 'stalled' });
      }
    }, 10_000);
  });

  simManager.on('disconnected', () => {
    if (dataWatchdog) { clearInterval(dataWatchdog); dataWatchdog = null; }
    lastFlightData = null;
    _simStartCheckDone = false;
    sendToRenderer('simconnect:status', { state: 'disconnected' });
    updateTrayMenu('idle');
    flightTracker.stop();
    sendToRenderer('flight:data', null);
    sendToRenderer('flight:phase', { phase: 'idle' });
  });

  simManager.on('error', (err) => {
    sendToRenderer('simconnect:status', { state: 'error', message: err.message });
    // Log the raw (unfriendified) error to the event log so the user can see
    // the actual failure reason (wrong path, ECONNREFUSED, permission, etc.).
    if (err.rawMessage && err.rawMessage !== err.message) {
      sendToRenderer('flight:event', {
        type:    'error',
        message: `SimConnect: ${err.rawMessage}`,
      });
    }
    updateTrayMenu('error');
  });

  simManager.on('data', (flightData) => {
    // Skip the mid-flight start check while only core SimVars are registered
    // (Phase 1 warmup — eng1/eng2 are defaulted to false and can't be trusted).
    // The check runs on the first full data frame once Phase 2 is active.
    if (!_simStartCheckDone && !flightData.coreOnly) {
      _simStartCheckDone = true;
      const enginesOn = flightData.eng1 || flightData.eng2;
      const airborne  = (flightData.altAgl ?? 0) > 1000 || flightData.groundSpeed > 80;
      if (enginesOn && airborne) {
        flightTracker.resumeMidFlight(flightData);
      } else {
        flightTracker.start();
      }
    }
    lastDataAt = Date.now();
    lastFlightData = flightData;
    try {
      flightTracker.update(flightData);
    } catch (err) {
      console.error('[Tracker] flightTracker.update() threw:', err);
    }
    sendToRenderer('flight:data', flightData);
  });

  simManager.on('aircraftType', (typeCode) => {
    if (flightTracker && typeof flightTracker.setAircraftType === 'function') {
      flightTracker.setAircraftType(typeCode);
    }
  });
}

function _buildScoringInput(record) {
  return {
    preFlight: {
      beaconOnBeforeTaxi: record.preFlight?.beaconOnBeforeTaxi ?? false,
    },

    taxiOut: {
      maxSpeed:       record.taxiOut?.maxSpeed       ?? 0,
      turnViolations: record.taxiOut?.turnViolations ?? 0,
      lightFraction:  record.taxiOut?.lightFraction  ?? 1.0,
    },

    takeoff: {
      vr:              record.takeoff?.vr              ?? null,
      rotateSpeed:     record.takeoff?.rotateSpeed     ?? null,
      landingLightsOn: record.takeoff?.landingLightsOn ?? false,
      bankViolations:  record.takeoff?.bankViolations  ?? 0,
      pitchViolations: record.takeoff?.pitchViolations ?? 0,
    },

    climb: {
      speedViolationsBelow10k: record.climb?.speedViolationsBelow10k ?? 0,
      bankViolations:          record.climb?.bankViolations          ?? 0,
      maxGForce:               record.climb?.maxGForce               ?? 0,
      strobeCompliance:        record.climb?.strobeCompliance        ?? 1.0,
      landingLightsViolation:  record.climb?.landingLightsViolation  ?? false,
    },

    cruise: {
      altViolations:  record.cruise?.altViolations  ?? 0,
      machRms:        record.cruise?.machRms        ?? 0,
      bankViolations: record.cruise?.bankViolations ?? 0,
      maxGForce:      record.cruise?.maxGForce      ?? 0,
    },

    descent: {
      speedViolationsBelow10k: record.descent?.speedViolationsBelow10k ?? 0,
      bankViolations:          record.descent?.bankViolations          ?? 0,
      pitchViolations:         record.descent?.pitchViolations         ?? 0,
      maxGForce:               record.descent?.maxGForce               ?? 0,
    },

    approach: {
      gearDownBy1000:     record.approach?.gearDownBy1000     ?? false,
      flapsSetBy1000:     record.approach?.flapsSetBy1000     ?? false,
      stabilisedBelow500: record.approach?.stabilisedBelow500 ?? false,
      gsDeviationRms:     record.approach?.gsDeviationRms     ?? 0,
      vapp:               record.approach?.vapp               ?? null,
      avgApproachSpeed:   record.approach?.avgApproachSpeed   ?? null,
    },

    landing: {
      touchdownVs:      record.landingRate      ?? 0,
      touchdownGForce:  record.touchdownGForce  ?? 0,
      touchdownPitch:   record.touchdownPitch   ?? 0,
      bounces:          record.bounces          ?? 0,
      tailStrike:       record.tailStrike       ?? false,
      touchdownZoneHit: record.touchdownZoneHit ?? false,
    },

    taxiIn: {
      maxSpeed:          record.taxiIn?.maxSpeed          ?? 0,
      turnViolations:    record.taxiIn?.turnViolations    ?? 0,
      lightFraction:     record.taxiIn?.lightFraction     ?? 1.0,
      landingLightsOff:  record.taxiIn?.landingLightsOff  ?? false,
      strobesOff:        record.taxiIn?.strobesOff        ?? false,
    },

    postFlight: {
      enginesOff: true, // reaching _completeFlight() means engines are off
      fuelUsed:   record.fuelUsed ?? 0,
    },
  };
}

function setupFlightTrackerListeners() {
  flightTracker.on('phase', (phase) => {
    sendToRenderer('flight:phase', phase);
    if (phase.phase === 'tracking' || phase.phase === 'cruise') {
      updateTrayMenu('tracking');
    }
  });

  flightTracker.on('midFlightResume', ({ phase }) => {
    sendToRenderer('flight:event', {
      type:    'notice',
      message: 'Resumed mid-flight — pre-departure stats unavailable',
      phase,
    });
    updateTrayMenu('tracking');
  });

  flightTracker.on('takeoff', (event) => {
    sendToRenderer('flight:event', { type: 'takeoff', ...event });
  });

  flightTracker.on('landing', (event) => {
    sendToRenderer('flight:event', { type: 'landing', ...event });
  });

  flightTracker.on('flightComplete', async (flightRecord) => {
    flightRecord.scoringInput = _buildScoringInput(flightRecord);
    sendToRenderer('flight:complete', flightRecord);
    updateTrayMenu('connected');

    // Auto-submit if signed in
    if (authState.isSignedIn) {
      try {
        const result = await apiClient.submitFlight(flightRecord);
        sendToRenderer('api:submit', { success: true, data: result });
      } catch (err) {
        sendToRenderer('api:submit', { success: false, error: err.message });
      }
    }
  });

  // Wire high-frequency approach polling to SimConnect
  flightTracker.on('highFreq', ({ enabled }) => {
    if (simManager) simManager.setHighFreqMode(enabled);
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

  // Settings (no API token anymore — auth is via Clerk)
  ipcMain.handle('settings:load', () => ({
    apiUrl:         store.get('apiUrl'),
    autoConnect:    store.get('autoConnect'),
    minimizeToTray: store.get('minimizeToTray'),
    mapboxToken:    store.get('mapboxToken'),
  }));

  ipcMain.handle('settings:save', (_, settings) => {
    if (settings.apiUrl !== undefined)         store.set('apiUrl', settings.apiUrl);
    if (settings.autoConnect !== undefined)    store.set('autoConnect', settings.autoConnect);
    if (settings.minimizeToTray !== undefined) store.set('minimizeToTray', settings.minimizeToTray);
    if (settings.mapboxToken !== undefined)    store.set('mapboxToken', settings.mapboxToken);

    if (apiClient) {
      apiClient.setBaseUrl(store.get('apiUrl'));
    }

    // If the API URL changed, reload the auth window so Clerk points to the right server
    if (settings.apiUrl && authWindow && !authWindow.isDestroyed()) {
      authWindow.loadURL(settings.apiUrl).catch(() => {});
    }

    return true;
  });

  // Manual flight submit
  ipcMain.handle('api:submitFlight', async (_, flightRecord) => {
    if (!apiClient) return { success: false, error: 'API client not initialized' };
    if (!authState.isSignedIn) return { success: false, error: 'Not signed in. Please sign in first.' };
    try {
      const result = await apiClient.submitFlight(flightRecord);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Auth: show sign-in window
  ipcMain.handle('auth:signIn', async () => {
    if (!authWindow || authWindow.isDestroyed()) {
      await createAuthWindow();
    }
    const webAppUrl = store.get('apiUrl', 'https://simcrewops.com');
    // Navigate to sign-in page if not already there
    const currentUrl = authWindow.webContents.getURL();
    if (!currentUrl.includes('/sign-in') && !currentUrl.includes('/sign-up')) {
      await authWindow.loadURL(`${webAppUrl}/sign-in`).catch(() => {});
    }
    authWindow.show();
    authWindow.focus();
    return true;
  });

  // Auth: sign out
  ipcMain.handle('auth:signOut', async () => {
    if (authWindow && !authWindow.isDestroyed()) {
      try {
        await authWindow.webContents.executeJavaScript(
          'window.Clerk ? window.Clerk.signOut() : null'
        );
      } catch {}
    }
    authState = { isSignedIn: false, user: null };
    store.set('userInfo', null);
    sendToRenderer('auth:stateChanged', authState);
    return true;
  });

  // Auth: get current state
  ipcMain.handle('auth:getStatus', () => authState);

  // Open external links
  ipcMain.on('open:external', (_, url) => shell.openExternal(url));

  // App info
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:getState', () => ({
    simConnected:  simManager?.isConnected() ?? false,
    trackingActive: flightTracker?.isTracking() ?? false,
    auth: authState,
    settings: {
      apiUrl:         store.get('apiUrl'),
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
    // Pass getClerkToken so ApiClient always uses a fresh JWT
    apiClient     = new ApiClient(store.get('apiUrl'), getClerkToken);

    setupSimConnectListeners();
    setupFlightTrackerListeners();
  } catch (err) {
    console.error('Failed to load core modules:', err);
  }

  registerIpcHandlers();
  createWindow();
  createTray();

  // Load the hidden auth window early so Clerk can restore a persisted session
  await createAuthWindow();

  // Heartbeat every 30 s — only when signed in. Position data is included so
  // the web app live map can refresh the aircraft marker each tick without
  // waiting for a full flight submission.
  heartbeatInterval = setInterval(() => {
    if (apiClient && authState.isSignedIn) {
      apiClient.sendHeartbeat(lastFlightData);
    }
  }, 30_000);

  // Startup heartbeat — captureAuthState() is async so isSignedIn may still be
  // false here; the immediate fire inside captureAuthState() handles that case.
  if (apiClient && authState.isSignedIn) {
    apiClient.sendHeartbeat(lastFlightData);
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
