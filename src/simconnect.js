'use strict';

/**
 * SimConnect Manager
 *
 * Wraps node-simconnect to read live flight data from MSFS 2020/2024.
 *
 * Adaptive polling: the caller can call setPollingInterval(seconds) to adjust
 * how often SimConnect delivers data frames. Critical phases (takeoff/landing)
 * use 1s; cruise uses 3s; idle/parked can use 10s. This reduces the callback
 * rate from the sim process and cuts IPC + CPU overhead while MSFS is running.
 *
 * Memory: each data frame is ~200 bytes; we never accumulate them.
 */

const { EventEmitter } = require('events');

const DEF_ID           = 0;
const REQ_ID_PERIODIC  = 0;
const RECONNECT_DELAY  = 5000;

// Polling seconds → SimConnect interval param (SECOND period = 1Hz base).
// interval=0 → every second, interval=N → every (N+1) seconds.
function secondsToInterval(s) {
  return Math.max(0, Math.round(s) - 1);
}

class SimConnectManager extends EventEmitter {
  constructor() {
    super();
    this._handle          = null;
    this._connected       = false;
    this._stopReconnect   = false;
    this._pollSeconds     = 1;        // current target
    this._activePollSecs  = null;     // what SimConnect is actually set to
    this._SimConnectPeriod = null;    // cached after first connect
  }

  isConnected() { return this._connected; }

  /**
   * Change how often SimConnect delivers data.
   * Safe to call at any time; no-op if already at the requested interval.
   *
   * Recommended intervals by phase:
   *   idle / pre_flight / post_flight : 10s
   *   taxi                            : 3s
   *   climb / cruise / descent        : 3s
   *   takeoff_roll / approach/landing : 1s
   */
  setPollingInterval(seconds) {
    this._pollSeconds = Math.max(1, seconds);
    if (!this._connected || !this._handle || this._activePollSecs === this._pollSeconds) return;
    this._applyPollingInterval();
  }

  _applyPollingInterval() {
    if (!this._handle || !this._SimConnectPeriod) return;
    const interval = secondsToInterval(this._pollSeconds);

    // Cancel current subscription then re-subscribe at new rate.
    try {
      this._handle.requestDataOnSimObject(
        REQ_ID_PERIODIC, DEF_ID, 0,
        this._SimConnectPeriod.NEVER, 0, 0, 0, 0
      );
      this._handle.requestDataOnSimObject(
        REQ_ID_PERIODIC, DEF_ID, 0,
        this._SimConnectPeriod.SECOND, 0, 0, interval, 0
      );
      this._activePollSecs = this._pollSeconds;
    } catch (e) {
      console.warn('[SimConnect] Could not change polling interval:', e.message);
    }
  }

  async connect() {
    this._stopReconnect = false;
    await this._tryConnect();
  }

  async _tryConnect() {
    try {
      let sc;
      try { sc = require('node-simconnect'); }
      catch { throw new Error('node-simconnect not found. Requires Windows + MSFS installed.'); }

      const { open, Protocol, SimConnectDataType, SimConnectPeriod } = sc;
      this._SimConnectPeriod = SimConnectPeriod;

      const { recvOpen, handle } = await open('SimCrewOps Tracker', Protocol.KittyHawk);
      this._handle     = handle;
      this._connected  = true;

      // ── Define SimVars (order matches _parse below) ───────────────────────
      const dt = SimConnectDataType;
      handle.addToDataDefinition(DEF_ID, 'PLANE LATITUDE',             'degrees',         dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE LONGITUDE',            'degrees',         dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE ALTITUDE',             'feet',            dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE HEADING DEGREES TRUE', 'degrees',         dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'AIRSPEED INDICATED',         'knots',           dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'GROUND VELOCITY',            'knots',           dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'VERTICAL SPEED',             'feet per minute', dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'SIM ON GROUND',              'bool',            dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'ENG COMBUSTION:1',           'bool',            dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'ENG COMBUSTION:2',           'bool',            dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'GEAR HANDLE POSITION',       'bool',            dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'FLAPS HANDLE INDEX',         'number',          dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'FUEL TOTAL QUANTITY',        'gallons',         dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'G FORCE',                    'gforce',          dt.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'AUTOPILOT MASTER',           'bool',            dt.FLOAT64);

      // Start with current target interval
      const interval = secondsToInterval(this._pollSeconds);
      handle.requestDataOnSimObject(
        REQ_ID_PERIODIC, DEF_ID, 0,
        SimConnectPeriod.SECOND, 0, 0, interval, 0
      );
      this._activePollSecs = this._pollSeconds;

      handle.on('simObjectData', (recv) => {
        if (recv.requestID !== REQ_ID_PERIODIC) return;
        const data = this._parse(recv.data);
        if (data) this.emit('data', data);
      });

      handle.on('exception', (recv) => {
        console.warn('[SimConnect] Exception code', recv.exception);
      });

      handle.on('close', () => this._onDisconnect());
      handle.on('error',  () => this._onDisconnect());

      this.emit('connected', {
        simVersion: recvOpen?.applicationName ?? 'Microsoft Flight Simulator',
      });

    } catch (err) {
      this._connected = false;
      this._handle    = null;
      this.emit('error', new Error(this._friendlyError(err)));

      if (!this._stopReconnect) {
        setTimeout(() => {
          if (!this._stopReconnect && !this._connected) this._tryConnect();
        }, RECONNECT_DELAY);
      }
    }
  }

  _parse(buf) {
    try {
      return {
        lat:         buf.readFloat64(),
        lon:         buf.readFloat64(),
        altitude:    Math.round(buf.readFloat64()),
        heading:     Math.round(buf.readFloat64()),
        ias:         Math.round(buf.readFloat64()),
        groundSpeed: Math.round(buf.readFloat64()),
        vs:          Math.round(buf.readFloat64()),
        onGround:    buf.readFloat64() > 0.5,
        eng1:        buf.readFloat64() > 0.5,
        eng2:        buf.readFloat64() > 0.5,
        gearDown:    buf.readFloat64() > 0.5,
        flapsIndex:  Math.round(buf.readFloat64()),
        fuelGallons: Math.round(buf.readFloat64() * 10) / 10,
        gForce:      Math.round(buf.readFloat64() * 100) / 100,
        autopilot:   buf.readFloat64() > 0.5,
        timestamp:   Date.now(),
      };
    } catch { return null; }
  }

  _onDisconnect() {
    if (!this._connected) return;
    this._connected      = false;
    this._handle         = null;
    this._activePollSecs = null;
    this.emit('disconnected');

    if (!this._stopReconnect) {
      setTimeout(() => {
        if (!this._stopReconnect && !this._connected) this._tryConnect();
      }, RECONNECT_DELAY);
    }
  }

  disconnect() {
    this._stopReconnect = true;
    if (this._handle) {
      try { this._handle.close(); } catch {}
      this._handle = null;
    }
    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
  }

  _friendlyError(err) {
    const m = err?.message ?? String(err);
    if (m.includes('ECONNREFUSED') || m.includes('connect'))
      return 'MSFS is not running. Start Microsoft Flight Simulator first.';
    if (m.includes('not found') || m.includes('MODULE_NOT_FOUND'))
      return 'SimConnect not found. Run on Windows with MSFS installed.';
    return m;
  }
}

module.exports = SimConnectManager;
