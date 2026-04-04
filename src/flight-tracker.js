'use strict';

/**
 * FlightTracker
 *
 * State machine: IDLE → PRE_FLIGHT → TAXI → TAKEOFF_ROLL → AIRBORNE →
 *                CLIMB → CRUISE → DESCENT → APPROACH → LANDING → POST_FLIGHT
 *
 * Memory budget:
 *   - Route points capped at MAX_ROUTE_POINTS (50). Oldest are dropped.
 *     The API submission never sends route geometry — only aggregate stats.
 *   - Only stores points during airborne phases; no accumulation on ground.
 *
 * CPU budget:
 *   - Emits a recommended SimConnect polling interval on each phase change
 *     so the caller can tell node-simconnect to poll less often in cruise.
 */

const { EventEmitter } = require('events');
const Airports = require('./airports');

const PHASE = {
  IDLE:         'idle',
  PRE_FLIGHT:   'pre_flight',
  TAXI:         'taxi',
  TAKEOFF_ROLL: 'takeoff_roll',
  AIRBORNE:     'airborne',
  CLIMB:        'climb',
  CRUISE:       'cruise',
  DESCENT:      'descent',
  APPROACH:     'approach',
  LANDING:      'landing',
  POST_FLIGHT:  'post_flight',
};

// ── Thresholds ────────────────────────────────────────────────────────────────
const TAKEOFF_IAS_KT      = 60;
const LANDING_GS_KT       = 10;
const CRUISE_ALT_FT       = 10000;
const APPROACH_ALT_FT     = 5000;
const VS_CLIMB_FPM        = 200;
const VS_DESCENT_FPM      = -200;
const ENGINES_OFF_TIMEOUT = 30000;   // ms

// Route point intervals by phase (ms between stored points)
const ROUTE_INTERVAL_BY_PHASE = {
  climb:    20000,   // every 20s
  cruise:   30000,   // every 30s — long cruise = fewer points needed
  descent:  20000,
  approach: 10000,
  default:  15000,
};

// Recommended SimConnect polling seconds by phase
const POLL_SECS_BY_PHASE = {
  idle:         10,
  pre_flight:   10,
  taxi:          3,
  takeoff_roll:  1,
  airborne:      1,
  climb:         3,
  cruise:        3,
  descent:       3,
  approach:      1,
  landing:       1,
  post_flight:   5,
};

// Maximum number of route points kept in memory at any time
const MAX_ROUTE_POINTS = 50;

class FlightTracker extends EventEmitter {
  constructor() {
    super();
    this._active          = false;
    this._phase           = PHASE.IDLE;
    this._prevOnGround    = true;
    this._enginesOffAt    = null;
    this._performanceMode = false;

    this._routePoints     = [];   // capped at MAX_ROUTE_POINTS
    this._lastRouteAt     = 0;
    this._takeoffTime     = null;
    this._maxAlt          = 0;
    this._maxGForce       = 0;
    this._fuelAtStart     = null;
    this._fuelAtEnd       = null;
    this._departureIcao   = null;
    this._arrivalIcao     = null;
    this._touchdownVs     = 0;

    this._airports = new Airports();
  }

  isTracking()  { return this._active; }
  getCurrentPhase() { return this._phase; }

  setPerformanceMode(enabled) {
    this._performanceMode = !!enabled;
  }

  start() {
    this._active = true;
    this._setPhase(PHASE.PRE_FLIGHT);
  }

  stop() {
    this._active = false;
    this._setPhase(PHASE.IDLE);
  }

  startTracking() {
    this._active = true;
    if (this._phase === PHASE.IDLE) this._setPhase(PHASE.PRE_FLIGHT);
  }

  stopTracking() {
    this._active = false;
    this._setPhase(PHASE.IDLE);
    this._resetFlightRecord();
  }

  update(data) {
    if (!this._active) return;

    // Track flight maximums (runs every tick regardless of UI throttle)
    if (data.altitude > this._maxAlt)   this._maxAlt   = data.altitude;
    if (data.gForce   > this._maxGForce) this._maxGForce = data.gForce;
    if (this._fuelAtStart === null)      this._fuelAtStart = data.fuelGallons;

    // Store route point (only while airborne, with phase-dependent interval)
    const airborne = [PHASE.CLIMB, PHASE.CRUISE, PHASE.DESCENT, PHASE.APPROACH, PHASE.AIRBORNE];
    if (airborne.includes(this._phase)) {
      const intervalMs = ROUTE_INTERVAL_BY_PHASE[this._phase] ?? ROUTE_INTERVAL_BY_PHASE.default;
      const effectiveInterval = this._performanceMode ? intervalMs * 2 : intervalMs;
      const now = Date.now();

      if (now - this._lastRouteAt >= effectiveInterval) {
        // Ring buffer: drop oldest when at capacity
        if (this._routePoints.length >= MAX_ROUTE_POINTS) {
          this._routePoints.shift();
        }
        this._routePoints.push({ lat: data.lat, lon: data.lon, alt: data.altitude });
        this._lastRouteAt = now;
      }
    }

    this._runStateMachine(data);
    this._prevOnGround = data.onGround;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  _runStateMachine(d) {
    const enginesOn = d.eng1 || d.eng2;

    switch (this._phase) {
      case PHASE.IDLE: break;

      case PHASE.PRE_FLIGHT:
        if (enginesOn && d.onGround) {
          this._departureIcao = this._airports.nearest(d.lat, d.lon);
          this._fuelAtStart   = d.fuelGallons;
          this._resetFlightRecord();
          this._setPhase(PHASE.TAXI);
        }
        break;

      case PHASE.TAXI:
        if (!enginesOn) {
          this._setPhase(PHASE.PRE_FLIGHT);
        } else if (d.groundSpeed > TAKEOFF_IAS_KT && d.onGround) {
          this._setPhase(PHASE.TAKEOFF_ROLL);
        }
        break;

      case PHASE.TAKEOFF_ROLL:
        if (!d.onGround) {
          this._takeoffTime = Date.now();
          this._setPhase(PHASE.AIRBORNE);
          this.emit('takeoff', { airport: this._departureIcao, ias: d.ias, time: this._takeoffTime });
        } else if (d.groundSpeed < 10) {
          this._setPhase(PHASE.TAXI);
        }
        break;

      case PHASE.AIRBORNE:
        if (d.vs > VS_CLIMB_FPM) {
          this._setPhase(PHASE.CLIMB);
        } else if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        }
        break;

      case PHASE.CLIMB:
        if (d.altitude > CRUISE_ALT_FT && d.vs < VS_CLIMB_FPM && d.vs > VS_DESCENT_FPM) {
          this._setPhase(PHASE.CRUISE);
        } else if (d.vs < VS_DESCENT_FPM && d.altitude < CRUISE_ALT_FT) {
          this._setPhase(PHASE.DESCENT);
        } else if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        }
        break;

      case PHASE.CRUISE:
        if (d.vs < VS_DESCENT_FPM) this._setPhase(PHASE.DESCENT);
        break;

      case PHASE.DESCENT:
        if (d.altitude < APPROACH_ALT_FT && d.vs < VS_DESCENT_FPM) {
          this._setPhase(PHASE.APPROACH);
        } else if (d.vs > VS_CLIMB_FPM) {
          this._setPhase(PHASE.CLIMB);
        } else if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        }
        break;

      case PHASE.APPROACH:
        if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        } else if (d.vs > VS_CLIMB_FPM) {
          this._setPhase(PHASE.CLIMB);  // go-around
        }
        break;

      case PHASE.LANDING:
        if (d.groundSpeed < LANDING_GS_KT) this._setPhase(PHASE.POST_FLIGHT);
        break;

      case PHASE.POST_FLIGHT:
        if (!enginesOn) {
          if (!this._enginesOffAt) this._enginesOffAt = Date.now();
          else if (Date.now() - this._enginesOffAt > ENGINES_OFF_TIMEOUT) {
            this._completeFlight(d);
            this._setPhase(PHASE.PRE_FLIGHT);
            this._enginesOffAt = null;
          }
        } else {
          this._enginesOffAt = null;
        }
        break;
    }
  }

  _handleTouchdown(d) {
    this._touchdownVs = d.vs;
    this._arrivalIcao = this._airports.nearest(d.lat, d.lon);
    this._fuelAtEnd   = d.fuelGallons;
    this._setPhase(PHASE.LANDING);
    this.emit('landing', {
      airport:     this._arrivalIcao,
      landingRate: Math.round(d.vs),
      gForce:      d.gForce,
      time:        Date.now(),
    });
  }

  _completeFlight(d) {
    if (!this._takeoffTime) return;

    const durationMin = Math.max(1, Math.round((Date.now() - this._takeoffTime) / 60000));
    const fuelUsed    = (this._fuelAtStart !== null && this._fuelAtEnd !== null)
      ? Math.round((this._fuelAtStart - this._fuelAtEnd) * 10) / 10
      : null;

    // Emit only the aggregate stats the API needs — no geometry array.
    // Route points stay local-only for the mini-map; strip before emitting
    // to avoid serialising up to 50 objects through IPC needlessly.
    this.emit('flightComplete', {
      sessionDate: new Date().toISOString().split('T')[0],
      aircraft:    'UNKN',
      departure:   this._departureIcao,
      arrival:     this._arrivalIcao,
      duration:    durationMin,
      landingRate: Math.round(this._touchdownVs),
      maxAltitude: this._maxAlt,
      maxGForce:   Math.round(this._maxGForce * 100) / 100,
      fuelUsed,
      simVersion:  'MSFS 2020/2024',
      source:      'simconnect',
    });

    this._resetFlightRecord();
  }

  _resetFlightRecord() {
    this._routePoints   = [];
    this._lastRouteAt   = 0;
    this._takeoffTime   = null;
    this._maxAlt        = 0;
    this._maxGForce     = 0;
    this._fuelAtStart   = null;
    this._fuelAtEnd     = null;
    this._departureIcao = null;
    this._arrivalIcao   = null;
    this._touchdownVs   = 0;
  }

  _setPhase(phase) {
    if (this._phase === phase) return;
    const prev = this._phase;
    this._phase = phase;

    // Recommended SimConnect poll rate for this phase
    let pollSecs = POLL_SECS_BY_PHASE[phase] ?? 3;
    if (this._performanceMode) pollSecs = Math.min(10, pollSecs * 2);

    this.emit('phase', { phase, prev, pollSecs });
  }
}

module.exports = FlightTracker;
