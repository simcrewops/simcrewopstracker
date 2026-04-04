'use strict';

/**
 * SimConnect Manager
 *
 * Wraps node-simconnect to read live flight data from MSFS 2020/2024.
 * Emits 'connected', 'disconnected', 'error', and 'data' events.
 *
 * node-simconnect only works on Windows with MSFS running.
 * On other platforms or when MSFS is not running, connection attempts fail
 * gracefully and the manager emits an 'error' event.
 */

const { EventEmitter } = require('events');

// SimConnect data definition ID
const DEF_ID = 0;
// SimConnect request IDs
const REQ_ID_PERIODIC = 0;
const REQ_ID_ONCE     = 1;

// Reconnect delay in ms
const RECONNECT_DELAY = 5000;

class SimConnectManager extends EventEmitter {
  constructor() {
    super();
    this._handle       = null;
    this._connected    = false;
    this._reconnecting = false;
    this._stopReconnect = false;
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

      const {
        open,
        Protocol,
        SimConnectDataType,
        SimConnectPeriod,
        SimObjectType,
      } = nodeSimConnect;

      // Try MSFS 2024 (FSX_SP2) first, fall back to FSX_SP2 which covers 2020 too
      const { recvOpen, handle } = await open('SimCrewOps Tracker', Protocol.KittyHawk);
      this._handle = handle;
      this._connected = true;
      this._reconnecting = false;

      // ── Define SimVars ────────────────────────────────────────────────────
      // Each call adds one variable to definition DEF_ID.
      // Order matters – we read them back in the same order.
      const d = SimConnectDataType;
      handle.addToDataDefinition(DEF_ID, 'PLANE LATITUDE',              'degrees',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE LONGITUDE',             'degrees',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE ALTITUDE',              'feet',             d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE ALT ABOVE GROUND',      'feet',             d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'PLANE HEADING DEGREES TRUE',  'degrees',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'AIRSPEED INDICATED',          'knots',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'GROUND VELOCITY',             'knots',            d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'VERTICAL SPEED',              'feet per minute',  d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'SIM ON GROUND',               'bool',             d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'ENG COMBUSTION:1',            'bool',             d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'ENG COMBUSTION:2',            'bool',             d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'GEAR HANDLE POSITION',        'bool',             d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'FLAPS HANDLE INDEX',          'number',           d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'FUEL TOTAL QUANTITY',         'gallons',          d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'G FORCE',                     'gforce',           d.FLOAT64);
      handle.addToDataDefinition(DEF_ID, 'AUTOPILOT MASTER',            'bool',             d.FLOAT64);

      // Request data every sim second (SECOND period)
      handle.requestDataOnSimObject(
        REQ_ID_PERIODIC,
        DEF_ID,
        0, // SIMCONNECT_OBJECT_ID_USER = 0
        SimConnectPeriod.SECOND,
        0, // flags
        0, // origin
        0, // interval
        0  // limit (0 = unlimited)
      );

      // ── Event handlers ────────────────────────────────────────────────────
      handle.on('simObjectData', (recv) => {
        if (recv.requestID !== REQ_ID_PERIODIC) return;
        const data = this._parseSimData(recv.data);
        if (data) this.emit('data', data);
      });

      handle.on('exception', (recv) => {
        console.warn('[SimConnect] Exception:', recv.exception, 'sendID:', recv.sendID);
      });

      handle.on('close', () => {
        this._onDisconnect();
      });

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

      // Schedule reconnect
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

  _parseSimData(buf) {
    try {
      return {
        lat:         buf.readFloat64(),
        lon:         buf.readFloat64(),
        altitude:    Math.round(buf.readFloat64()),
        altAgl:      Math.round(buf.readFloat64()),   // feet above ground level
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
    } catch (err) {
      console.error('[SimConnect] Failed to parse SimData:', err);
      return null;
    }
  }

  _onDisconnect() {
    if (!this._connected) return;
    this._connected = false;
    const oldHandle = this._handle;
    this._handle    = null;
    // Strip listeners from the stale handle so stray events after close
    // don't trigger another disconnect/reconnect cycle.
    if (oldHandle) { try { oldHandle.removeAllListeners(); } catch {} }
    this.emit('disconnected');

    // Auto-reconnect
    if (!this._stopReconnect) {
      this._reconnecting = true;
      setTimeout(() => {
        if (!this._stopReconnect && !this._connected) {
          this._connect();
        }
      }, RECONNECT_DELAY);
    }
  }

  disconnect() {
    this._stopReconnect = true;
    this._reconnecting  = false;
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
