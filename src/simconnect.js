'use strict';

/**
 * SimConnect Manager
 *
 * Wraps node-simconnect to read live flight data from MSFS 2020/2024.
 * Emits 'connected', 'disconnected', 'error', 'data', and 'aircraftType' events.
 *
 * SimVar registration is split into two phases to detect bad SimVar names that
 * cause MSFS 2024 to drop the connection immediately:
 *
 *   Phase 1 — 9 core navigation/state vars, registered with a 30 ms stagger.
 *              Data starts flowing right away for the live display.
 *   Phase 2 — 17 extended vars (engines, lights, fuel, etc.) added after a
 *              1-second stability window. Full data then replaces core data.
 *
 * If a disconnect happens mid-registration the last SimVar name is logged so
 * the bad var can be identified.
 */

const { EventEmitter } = require('events');

// ── Data definition IDs ───────────────────────────────────────────────────────
const DEF_ID_CORE   = 0; // 9 core vars (nav + basic state)
const DEF_ID_FULL   = 1; // all 26 vars (core + extended)
const DEF_ID_STRING = 2; // one-shot: ATC TYPE string

// ── Request IDs ───────────────────────────────────────────────────────────────
const REQ_ID_CORE     = 0; // 1 Hz core-only data (Phase 1 warmup)
const REQ_ID_PERIODIC = 1; // 1 Hz full data (Phase 2 normal operation)
const REQ_ID_ONCE     = 2; // one-shot ATC TYPE
const REQ_ID_HIGHFREQ = 3; // ~100 ms approach data

// ── Timing constants ──────────────────────────────────────────────────────────
const RECONNECT_DELAY   = 5000; // ms between reconnect attempts
const SIMVAR_STAGGER_MS = 30;   // ms between addToDataDefinition calls (MSFS 2024 safety)
const CORE_CONFIRM_MS   = 1000; // ms to wait for stability before Phase 2

// ── Core SimVars (Phase 1) ────────────────────────────────────────────────────
// Minimal safe set — sufficient for live nav display and phase detection.
// 'PLANE ALT ABOVE GROUND LEVEL' (not 'PLANE ALT ABOVE GROUND') is the correct
// MSFS 2024 name; the shorter alias is rejected by some sim builds.
const CORE_VARS = [
  ['PLANE LATITUDE',               'degrees'],
  ['PLANE LONGITUDE',              'degrees'],
  ['PLANE ALTITUDE',               'feet'],
  ['PLANE ALT ABOVE GROUND LEVEL', 'feet'],
  ['PLANE HEADING DEGREES TRUE',   'degrees'],
  ['AIRSPEED INDICATED',           'knots'],
  ['GROUND VELOCITY',              'knots'],
  ['VERTICAL SPEED',               'feet per minute'],
  ['SIM ON GROUND',                'bool'],
];

// ── Extended SimVars (Phase 2) ────────────────────────────────────────────────
// Registered only after the core set is confirmed stable (no disconnect in 1 s).
const EXTENDED_VARS = [
  ['ENG COMBUSTION:1',         'bool'],
  ['ENG COMBUSTION:2',         'bool'],
  ['GEAR HANDLE POSITION',     'bool'],
  ['FLAPS HANDLE INDEX',       'number'],
  ['FUEL TOTAL QUANTITY WEIGHT', 'pounds'],
  ['G FORCE',                  'gforce'],
  ['AUTOPILOT MASTER',         'bool'],
  ['PLANE PITCH DEGREES',      'degrees'],
  ['PLANE BANK DEGREES',       'degrees'],
  ['AIRSPEED MACH',            'mach'],
  ['NAV GLIDE SLOPE ERROR',    'degrees'],
  ['LIGHT BEACON',             'bool'],
  ['LIGHT NAV',                'bool'],
  ['LIGHT STROBE',             'bool'],
  ['LIGHT LANDING',            'bool'],
  ['LIGHT TAXI',               'bool'],
  ['PARKING BRAKE INDICATOR',  'bool'],
];

class SimConnectManager extends EventEmitter {
  constructor() {
    super();
    this._handle           = null;
    this._connected        = false;
    this._reconnecting     = false;
    this._stopReconnect    = false;
    this._highFreqMode     = false;
    this._SimConnectPeriod = null;
    this._fullDataActive   = false; // true once Phase 2 is active
    this._lastSimVar       = null;  // last var registered — for disconnect diagnostics
  }

  isConnected() {
    return this._connected;
  }

  async connect() {
    this._stopReconnect = false;
    await this._connect();
  }

  async _connect() {
    try {
      let nodeSimConnect;
      try {
        nodeSimConnect = require('node-simconnect');
      } catch (e) {
        throw new Error(
          'node-simconnect not found. This feature requires Windows with MSFS 2020 or 2024 installed.'
        );
      }

      const { open, Protocol, SimConnectDataType, SimConnectPeriod } = nodeSimConnect;
      this._SimConnectPeriod = SimConnectPeriod;

      const { recvOpen, handle } = await open('SimCrewOps Tracker', Protocol.KittyHawk);
      this._handle         = handle;
      this._connected      = true;
      this._reconnecting   = false;
      this._fullDataActive = false;
      this._lastSimVar     = null;

      // ── Event handlers ──────────────────────────────────────────────────────
      // Set up BEFORE async SimVar registration so a disconnect during
      // registration is captured and _onDisconnect() fires correctly.
      handle.on('simObjectData', (recv) => {
        if (recv.requestID === REQ_ID_ONCE) {
          try {
            const typeCode = recv.data.readString256().replace(/\0/g, '').trim();
            if (typeCode) this.emit('aircraftType', typeCode);
          } catch (e) {
            console.warn('[SimConnect] Failed to read ATC TYPE:', e.message);
          }
          return;
        }

        if (recv.requestID === REQ_ID_CORE) {
          const data = this._parseCoreData(recv.data);
          if (data) this.emit('data', data);
          return;
        }

        if (recv.requestID !== REQ_ID_PERIODIC && recv.requestID !== REQ_ID_HIGHFREQ) return;
        const data = this._parseSimData(recv.data);
        if (data) {
          if (recv.requestID === REQ_ID_HIGHFREQ) data.highFreq = true;
          this.emit('data', data);
        }
      });

      handle.on('exception', (recv) => {
        console.warn('[SimConnect] Exception:', recv.exception, 'sendID:', recv.sendID);
      });

      handle.on('close', () => this._onDisconnect());

      handle.on('error', (err) => {
        console.error('[SimConnect] Error:', err);
        this._onDisconnect();
      });

      this.emit('connected', {
        simVersion: recvOpen?.applicationName ?? 'Microsoft Flight Simulator',
        simBuild:   recvOpen?.applicationBuildMajor ?? 0,
      });
      console.log('[SimConnect] Connected to', recvOpen?.applicationName ?? 'MSFS');

      // Register SimVars asynchronously (non-blocking) so connection events
      // can fire normally while registration is in progress.
      this._registerSimVars(handle, SimConnectDataType, SimConnectPeriod).catch(err => {
        console.error('[SimConnect] SimVar registration error:', err.message);
      });

    } catch (err) {
      this._connected      = false;
      this._fullDataActive = false;
      this._handle         = null;
      const msg = this._friendlyError(err);
      this.emit('error', new Error(msg));
      console.error('[SimConnect] Connection failed:', msg);

      if (!this._stopReconnect) {
        this._reconnecting = true;
        setTimeout(() => {
          if (!this._stopReconnect && !this._connected) {
            this._connect();
          }
        }, RECONNECT_DELAY);
      }
    }
  }

  /**
   * Two-phase SimVar registration with per-var stagger and disconnect detection.
   *
   * Phase 1: CORE_VARS → start 1 Hz core data stream → wait CORE_CONFIRM_MS
   * Phase 2: CORE_VARS + EXTENDED_VARS → switch to full data stream
   *
   * If the connection drops at any point, this._lastSimVar identifies the
   * last successfully registered var (the next one may be the bad one).
   */
  async _registerSimVars(handle, d, P) {
    // Register the ATC TYPE string definition upfront (no stagger needed)
    handle.addToDataDefinition(DEF_ID_STRING, 'ATC TYPE', null, d.STRING256);

    // ── Phase 1: core vars ──────────────────────────────────────────────────
    console.log(`[SimConnect] Phase 1: registering ${CORE_VARS.length} core SimVars…`);
    for (const [name, unit] of CORE_VARS) {
      if (!this._connected) {
        console.warn(`[SimConnect] Phase 1 disconnect. Last registered: "${this._lastSimVar ?? 'none'}"`);
        return;
      }
      this._lastSimVar = name;
      handle.addToDataDefinition(DEF_ID_CORE, name, unit, d.FLOAT64);
      await this._stagger();
    }

    if (!this._connected) {
      console.warn(`[SimConnect] Phase 1 post-loop disconnect. Last registered: "${this._lastSimVar}"`);
      return;
    }

    // Start core-only data stream + one-shot ATC type request
    handle.requestDataOnSimObject(REQ_ID_CORE, DEF_ID_CORE,   0, P.SECOND, 0, 0, 0, 0);
    handle.requestDataOnSimObject(REQ_ID_ONCE, DEF_ID_STRING, 0, P.ONCE,   0, 0, 0, 0);
    console.log('[SimConnect] Phase 1 active — core data flowing. Checking stability…');

    // Stability window: confirm the core vars don't trigger an MSFS reject
    await new Promise(r => setTimeout(r, CORE_CONFIRM_MS));
    if (!this._connected) {
      console.warn('[SimConnect] Disconnected during stability window after Phase 1.');
      return;
    }

    // ── Phase 2: full SimVar set ────────────────────────────────────────────
    // DEF_ID_FULL is a separate definition that includes all 26 vars in the
    // same order, so the full parser always reads them at the correct offset.
    const allVars = [...CORE_VARS, ...EXTENDED_VARS];
    console.log(`[SimConnect] Phase 2: registering ${allVars.length} full SimVars…`);
    for (const [name, unit] of allVars) {
      if (!this._connected) {
        console.warn(`[SimConnect] Phase 2 disconnect. Last registered: "${this._lastSimVar}"`);
        return;
      }
      this._lastSimVar = name;
      handle.addToDataDefinition(DEF_ID_FULL, name, unit, d.FLOAT64);
      await this._stagger();
    }

    if (!this._connected) {
      console.warn(`[SimConnect] Phase 2 post-loop disconnect. Last registered: "${this._lastSimVar}"`);
      return;
    }

    // Switch from core-only stream to full stream
    handle.requestDataOnSimObject(REQ_ID_CORE,     DEF_ID_CORE, 0, P.NEVER,  0, 0, 0, 0);
    handle.requestDataOnSimObject(REQ_ID_PERIODIC, DEF_ID_FULL, 0, P.SECOND, 0, 0, 0, 0);
    this._fullDataActive = true;
    console.log(`[SimConnect] Phase 2 active — full dataset (${allVars.length} vars).`);
  }

  _stagger() {
    return new Promise(r => setTimeout(r, SIMVAR_STAGGER_MS));
  }

  /**
   * Parse a 9-float core data frame (Phase 1).
   * Extended fields are filled with safe defaults so the renderer and flight
   * tracker always receive a complete data object structure. The `coreOnly`
   * flag lets callers skip logic that requires full engine/brake data.
   */
  _parseCoreData(buf) {
    try {
      return {
        lat:          buf.readFloat64(),
        lon:          buf.readFloat64(),
        altitude:     Math.round(buf.readFloat64()),
        altAgl:       Math.round(buf.readFloat64()),
        heading:      Math.round(buf.readFloat64()),
        ias:          Math.round(buf.readFloat64()),
        groundSpeed:  Math.round(buf.readFloat64()),
        vs:           Math.round(buf.readFloat64()),
        onGround:     buf.readFloat64() > 0.5,
        // Extended defaults — updated once Phase 2 fires
        eng1:         false,
        eng2:         false,
        gearDown:     true,
        flapsIndex:   0,
        fuelLbs:  null,
        gForce:       1.0,
        autopilot:    false,
        pitch:        0,
        bankAngle:    0,
        mach:         0,
        gsDeviation:  0,
        lightBeacon:  false,
        lightNav:     false,
        lightStrobe:  false,
        lightLanding: false,
        lightTaxi:    false,
        parkingBrake: false,
        timestamp:    Date.now(),
        coreOnly:     true,
      };
    } catch (err) {
      console.error('[SimConnect] Failed to parse core data:', err);
      return null;
    }
  }

  /**
   * Parse a 26-float full data frame (Phase 2 + high-freq).
   * Field order must match CORE_VARS + EXTENDED_VARS exactly.
   */
  _parseSimData(buf) {
    try {
      return {
        lat:          buf.readFloat64(),
        lon:          buf.readFloat64(),
        altitude:     Math.round(buf.readFloat64()),
        altAgl:       Math.round(buf.readFloat64()),
        heading:      Math.round(buf.readFloat64()),
        ias:          Math.round(buf.readFloat64()),
        groundSpeed:  Math.round(buf.readFloat64()),
        vs:           Math.round(buf.readFloat64()),
        onGround:     buf.readFloat64() > 0.5,
        eng1:         buf.readFloat64() > 0.5,
        eng2:         buf.readFloat64() > 0.5,
        gearDown:     buf.readFloat64() > 0.5,
        flapsIndex:   Math.round(buf.readFloat64()),
        fuelLbs:  Math.round(buf.readFloat64()),
        gForce:       Math.round(buf.readFloat64() * 100) / 100,
        autopilot:    buf.readFloat64() > 0.5,
        pitch:        Math.round(buf.readFloat64() * 10) / 10,
        bankAngle:    Math.round(buf.readFloat64() * 10) / 10,
        mach:         Math.round(buf.readFloat64() * 1000) / 1000,
        gsDeviation:  Math.round(buf.readFloat64() * 100) / 100,
        lightBeacon:  buf.readFloat64() > 0.5,
        lightNav:     buf.readFloat64() > 0.5,
        lightStrobe:  buf.readFloat64() > 0.5,
        lightLanding: buf.readFloat64() > 0.5,
        lightTaxi:    buf.readFloat64() > 0.5,
        parkingBrake: buf.readFloat64() > 0.5,
        timestamp:    Date.now(),
      };
    } catch (err) {
      console.error('[SimConnect] Failed to parse SimData:', err);
      return null;
    }
  }

  _onDisconnect() {
    if (!this._connected) return;
    this._connected      = false;
    this._fullDataActive = false;
    const oldHandle = this._handle;
    this._handle    = null;
    if (oldHandle) { try { oldHandle.removeAllListeners(); } catch {} }
    this.emit('disconnected');

    if (!this._stopReconnect) {
      this._reconnecting = true;
      setTimeout(() => {
        if (!this._stopReconnect && !this._connected) {
          this._connect();
        }
      }, RECONNECT_DELAY);
    }
  }

  /**
   * Switch between 1 Hz normal polling and ~100 ms high-frequency polling.
   * Uses whichever definition is currently active (core or full).
   */
  setHighFreqMode(enabled) {
    if (!this._handle || !this._connected || !this._SimConnectPeriod) return;
    if (this._highFreqMode === enabled) return;
    this._highFreqMode = enabled;

    const P          = this._SimConnectPeriod;
    const activeDefId = this._fullDataActive ? DEF_ID_FULL : DEF_ID_CORE;
    const activeReqId = this._fullDataActive ? REQ_ID_PERIODIC : REQ_ID_CORE;

    if (enabled) {
      this._handle.requestDataOnSimObject(activeReqId,     activeDefId, 0, P.NEVER,     0, 0, 0, 0);
      this._handle.requestDataOnSimObject(REQ_ID_HIGHFREQ, activeDefId, 0, P.SIM_FRAME, 0, 0, 6, 0);
    } else {
      this._handle.requestDataOnSimObject(REQ_ID_HIGHFREQ, activeDefId, 0, P.NEVER,     0, 0, 0, 0);
      this._handle.requestDataOnSimObject(activeReqId,     activeDefId, 0, P.SECOND,    0, 0, 0, 0);
    }
  }

  disconnect() {
    this._stopReconnect  = true;
    this._reconnecting   = false;
    this._fullDataActive = false;
    if (this._handle) {
      try { this._handle.removeAllListeners(); } catch {}
      try { this._handle.close(); } catch {}
      this._handle = null;
    }
    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
  }

  _friendlyError(err) {
    const msg = err?.message ?? String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
      return 'MSFS is not running or SimConnect is unavailable. Please start Microsoft Flight Simulator first.';
    }
    if (msg.includes('not found') || msg.includes('MODULE_NOT_FOUND')) {
      return 'SimConnect library not found. Please run on Windows with MSFS installed.';
    }
    return msg;
  }
}

module.exports = SimConnectManager;
