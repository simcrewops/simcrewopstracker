'use strict';

/**
 * SimConnect Manager
 *
 * Wraps node-simconnect to read live flight data from MSFS 2020/2024.
 * Emits: 'connected', 'disconnected', 'error', 'data', 'landingData'
 *
 * Two data definitions:
 *   DEF_ID_MAIN (0)    — 32 SimVars, polled at 1 Hz (SECOND period)
 *   DEF_ID_LANDING (1) — 8 critical vars, polled at ~100ms via timed ONCE requests
 *                        (high-freq mode only, during approach/landing)
 *
 * Performance notes:
 *   - Normal polling is 1 Hz via SECOND period — zero CPU overhead between ticks
 *   - High-freq mode uses a 100ms setInterval with ONCE requests (only enabled
 *     when aircraft is below 500 ft AGL on approach)
 *   - Stale handle listeners are stripped on disconnect to prevent memory leaks
 */

const { EventEmitter } = require('events');

// SimConnect data definition IDs
const DEF_ID_MAIN    = 0;
const DEF_ID_LANDING = 1;

// SimConnect request IDs
const REQ_ID_PERIODIC = 0;   // 1 Hz main data
const REQ_ID_LANDING  = 1;   // high-freq landing data (ONCE per timer tick)

const RECONNECT_DELAY = 5000;  // ms between reconnect attempts
const HF_INTERVAL_MS  = 100;   // high-frequency polling interval (ms)

class SimConnectManager extends EventEmitter {
  constructor() {
    super();
    this._handle        = null;
    this._connected     = false;
    this._reconnecting  = false;
    this._stopReconnect = false;
    this._hfTimer       = null;   // high-frequency polling interval
    this._hfEnabled     = false;
    // Cache the SimConnectPeriod enum so we don't re-require on every HF tick
    this._SimConnectPeriod = null;
  }

  isConnected() { return this._connected; }

  async connect() {
    this._stopReconnect = false;
    await this._connect();
  }

  async _connect() {
    try {
      let nodeSimConnect;
      try {
        nodeSimConnect = require('node-simconnect');
      } catch {
        throw new Error(
          'node-simconnect not found. This feature requires Windows with MSFS 2020 or 2024 installed.'
        );
      }

      const {
        open,
        Protocol,
        SimConnectDataType,
        SimConnectPeriod,
      } = nodeSimConnect;

      // Cache for use in HF timer
      this._SimConnectPeriod = SimConnectPeriod;

      const { recvOpen, handle } = await open('SimCrewOps Tracker', Protocol.KittyHawk);
      this._handle    = handle;
      this._connected = true;
      this._reconnecting = false;

      const d = SimConnectDataType;

      // ── DEF_ID_MAIN: Full flight data (32 variables) ───────────────────────
      // Parse order in _parseMain must exactly match add order here.

      // Position
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE LATITUDE',                 'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE LONGITUDE',                'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE ALTITUDE',                 'feet',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE ALT ABOVE GROUND',         'feet',            d.FLOAT64);
      // Heading
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE HEADING DEGREES TRUE',     'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE HEADING DEGREES MAGNETIC', 'degrees',         d.FLOAT64);
      // Speed
      handle.addToDataDefinition(DEF_ID_MAIN, 'AIRSPEED INDICATED',             'knots',           d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'AIRSPEED TRUE',                  'knots',           d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'AIRSPEED MACH',                  'mach',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'GROUND VELOCITY',                'knots',           d.FLOAT64);
      // Vertical speed + attitude
      handle.addToDataDefinition(DEF_ID_MAIN, 'VERTICAL SPEED',                 'feet per minute', d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE PITCH DEGREES',            'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'PLANE BANK DEGREES',             'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'G FORCE',                        'gforce',          d.FLOAT64);
      // Ground state / engines
      handle.addToDataDefinition(DEF_ID_MAIN, 'SIM ON GROUND',                  'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'ENG COMBUSTION:1',               'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'ENG COMBUSTION:2',               'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'ENG COMBUSTION:3',               'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'ENG COMBUSTION:4',               'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'NUMBER OF ENGINES',              'number',          d.FLOAT64);
      // Controls
      handle.addToDataDefinition(DEF_ID_MAIN, 'GEAR HANDLE POSITION',           'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'FLAPS HANDLE INDEX',             'number',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'BRAKE PARKING POSITION',         'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'AUTOPILOT MASTER',               'bool',            d.FLOAT64);
      // Fuel
      handle.addToDataDefinition(DEF_ID_MAIN, 'FUEL TOTAL QUANTITY',            'gallons',         d.FLOAT64);
      // Lights
      handle.addToDataDefinition(DEF_ID_MAIN, 'LIGHT BEACON',                   'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'LIGHT NAV',                      'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'LIGHT STROBE',                   'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'LIGHT LANDING',                  'bool',            d.FLOAT64);
      // Navigation
      handle.addToDataDefinition(DEF_ID_MAIN, 'GPS GROUND MAGNETIC TRACK',      'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'NAV CDI:1',                      'number',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_MAIN, 'NAV GSI:1',                      'number',          d.FLOAT64);

      // ── DEF_ID_LANDING: 8 critical landing variables ───────────────────────
      // Used exclusively for high-frequency (100ms) polling during approach/touchdown.
      handle.addToDataDefinition(DEF_ID_LANDING, 'PLANE ALT ABOVE GROUND', 'feet',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'VERTICAL SPEED',         'feet per minute', d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'G FORCE',                'gforce',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'PLANE BANK DEGREES',     'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'PLANE PITCH DEGREES',    'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'SIM ON GROUND',          'bool',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'PLANE LATITUDE',         'degrees',         d.FLOAT64);
      handle.addToDataDefinition(DEF_ID_LANDING, 'PLANE LONGITUDE',        'degrees',         d.FLOAT64);

      // ── Start 1 Hz main data stream ────────────────────────────────────────
      handle.requestDataOnSimObject(
        REQ_ID_PERIODIC, DEF_ID_MAIN, 0,
        SimConnectPeriod.SECOND,
        0, 0, 0, 0
      );

      // ── SimConnect event handlers ──────────────────────────────────────────
      handle.on('simObjectData', (recv) => {
        if (recv.requestID === REQ_ID_PERIODIC) {
          const data = this._parseMain(recv.data);
          if (data) this.emit('data', data);
        } else if (recv.requestID === REQ_ID_LANDING) {
          const data = this._parseLanding(recv.data);
          if (data) this.emit('landingData', data);
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

    } catch (err) {
      this._connected = false;
      this._handle    = null;
      const msg = this._friendlyError(err);
      this.emit('error', new Error(msg));
      console.error('[SimConnect] Connection failed:', msg);

      if (!this._stopReconnect) {
        this._reconnecting = true;
        setTimeout(() => {
          if (!this._stopReconnect && !this._connected) this._connect();
        }, RECONNECT_DELAY);
      }
    }
  }

  /**
   * Enable or disable high-frequency landing data polling.
   *
   * When enabled: fires a ONCE request for DEF_ID_LANDING every 100ms.
   * Each request triggers a 'landingData' event via the simObjectData handler.
   * Only activate this during approach/landing — it's lightweight but unnecessary
   * during cruise.
   */
  setHighFreqMode(enabled) {
    if (enabled === this._hfEnabled) return;
    this._hfEnabled = enabled;

    if (enabled && this._handle && this._connected) {
      this._hfTimer = setInterval(() => {
        if (!this._handle || !this._connected) return;
        try {
          this._handle.requestDataOnSimObject(
            REQ_ID_LANDING, DEF_ID_LANDING, 0,
            this._SimConnectPeriod.ONCE,
            0, 0, 0, 0
          );
        } catch {
          // SimConnect may be in the middle of closing; ignore silently
        }
      }, HF_INTERVAL_MS);
      console.log('[SimConnect] High-freq mode ON (100ms landing data)');
    } else {
      this._stopHfTimer();
      console.log('[SimConnect] High-freq mode OFF');
    }
  }

  _stopHfTimer() {
    if (this._hfTimer) {
      clearInterval(this._hfTimer);
      this._hfTimer = null;
    }
    this._hfEnabled = false;
  }

  /**
   * Parse the 32-variable main data packet.
   * Read order MUST match addToDataDefinition order above.
   */
  _parseMain(buf) {
    try {
      const raw = {
        lat:          buf.readFloat64(),
        lon:          buf.readFloat64(),
        altitude:     Math.round(buf.readFloat64()),
        altAgl:       Math.round(buf.readFloat64()),
        headingTrue:  Math.round(buf.readFloat64()),
        headingMag:   Math.round(buf.readFloat64()),
        ias:          Math.round(buf.readFloat64()),
        tas:          Math.round(buf.readFloat64()),
        mach:         Math.round(buf.readFloat64() * 100) / 100,
        groundSpeed:  Math.round(buf.readFloat64()),
        vs:           Math.round(buf.readFloat64()),
        pitch:        Math.round(buf.readFloat64() * 10) / 10,
        bank:         Math.round(buf.readFloat64() * 10) / 10,
        gForce:       Math.round(buf.readFloat64() * 100) / 100,
        onGround:     buf.readFloat64() > 0.5,
        eng1:         buf.readFloat64() > 0.5,
        eng2:         buf.readFloat64() > 0.5,
        eng3:         buf.readFloat64() > 0.5,
        eng4:         buf.readFloat64() > 0.5,
        engineCount:  Math.round(buf.readFloat64()),
        gearDown:     buf.readFloat64() > 0.5,
        flapsIndex:   Math.round(buf.readFloat64()),
        parkingBrake: buf.readFloat64() > 0.5,
        autopilot:    buf.readFloat64() > 0.5,
        fuelGallons:  Math.round(buf.readFloat64() * 10) / 10,
        lightBeacon:  buf.readFloat64() > 0.5,
        lightNav:     buf.readFloat64() > 0.5,
        lightStrobe:  buf.readFloat64() > 0.5,
        lightLanding: buf.readFloat64() > 0.5,
        gpsTrack:     Math.round(buf.readFloat64()),
        navLocDev:    Math.round(buf.readFloat64() * 100) / 100,
        navGsDev:     Math.round(buf.readFloat64() * 100) / 100,
        timestamp:    Date.now(),
      };
      // Backward-compat alias used by renderer
      raw.heading = raw.headingTrue;
      return raw;
    } catch (err) {
      console.error('[SimConnect] Failed to parse main data:', err);
      return null;
    }
  }

  /**
   * Parse the 8-variable high-frequency landing data packet.
   */
  _parseLanding(buf) {
    try {
      return {
        altAgl:   Math.round(buf.readFloat64()),
        vs:       Math.round(buf.readFloat64()),
        gForce:   Math.round(buf.readFloat64() * 100) / 100,
        bank:     Math.round(buf.readFloat64() * 10) / 10,
        pitch:    Math.round(buf.readFloat64() * 10) / 10,
        onGround: buf.readFloat64() > 0.5,
        lat:      buf.readFloat64(),
        lon:      buf.readFloat64(),
        ts:       Date.now(),
      };
    } catch (err) {
      console.error('[SimConnect] Failed to parse landing data:', err);
      return null;
    }
  }

  _onDisconnect() {
    if (!this._connected) return;
    this._connected = false;
    this._stopHfTimer();

    // Strip listeners from stale handle before nulling it, so no stray events
    // after close trigger another disconnect cycle.
    const oldHandle = this._handle;
    this._handle    = null;
    if (oldHandle) { try { oldHandle.removeAllListeners(); } catch {} }

    this.emit('disconnected');

    if (!this._stopReconnect) {
      this._reconnecting = true;
      setTimeout(() => {
        if (!this._stopReconnect && !this._connected) this._connect();
      }, RECONNECT_DELAY);
    }
  }

  disconnect() {
    this._stopReconnect = true;
    this._reconnecting  = false;
    this._stopHfTimer();

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
