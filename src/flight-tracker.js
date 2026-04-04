'use strict';

/**
 * FlightTracker
 *
 * Receives raw SimConnect data frames and produces higher-level flight events:
 *  - phase changes (pre-flight → taxi → takeoff → climb → cruise → descent → approach → landing)
 *  - takeoff event (airport, time, IAS)
 *  - landing event (airport, landing rate in fpm, G-force)
 *  - flightComplete event (full flight record ready for API submission)
 *
 * Flight phase state machine:
 *
 *   IDLE → PRE_FLIGHT → TAXI → TAKEOFF_ROLL → AIRBORNE → CLIMB
 *        → CRUISE → DESCENT → APPROACH → LANDING → POST_FLIGHT → IDLE
 */

const { EventEmitter } = require('events');
const Airports = require('./airports');

// ── Phase constants ───────────────────────────────────────────────────────────
const PHASE = {
  IDLE:          'idle',
  PRE_FLIGHT:    'pre_flight',
  TAXI:          'taxi',
  TAKEOFF_ROLL:  'takeoff_roll',
  AIRBORNE:      'airborne',
  CLIMB:         'climb',
  CRUISE:        'cruise',
  DESCENT:       'descent',
  APPROACH:      'approach',
  LANDING:       'landing',
  POST_FLIGHT:   'post_flight',
};

// ── Thresholds ────────────────────────────────────────────────────────────────
const TAKEOFF_IAS_KT        = 60;   // IAS above which we call it airborne on rollout
const LANDING_GS_KT         = 10;   // GS below which we consider fully stopped after landing
const CRUISE_ALT_FT         = 10000; // Altitude above which we call it cruise
const APPROACH_ALT_FT       = 5000;  // Altitude below which (descending) we call it approach
const VS_CLIMB_FPM          = 200;   // VS above which = climbing
const VS_DESCENT_FPM        = -200;  // VS below which = descending
const ENGINES_OFF_TIMEOUT   = 30000; // ms engines must be off before post-flight
const DATA_INTERVAL_MS      = 10000; // Store a route point every 10 sec

class FlightTracker extends EventEmitter {
  constructor() {
    super();

    this._active        = false;   // Is the tracker enabled
    this._phase         = PHASE.IDLE;
    this._lastData      = null;
    this._prevOnGround  = true;
    this._enginesOffAt  = null;

    // Flight record being built
    this._flightRecord  = null;
    this._routePoints   = [];
    this._lastRouteAt   = 0;
    this._takeoffTime   = null;
    this._maxAlt        = 0;
    this._maxGForce     = 0;
    this._fuelAtStart   = null;
    this._fuelAtEnd     = null;
    this._departureIcao = null;
    this._arrivalIcao   = null;

    // Vertical speed at the moment wheels touch down (for landing rate calc)
    this._touchdownVs   = 0;

    this._airports = new Airports();
  }

  isTracking() {
    return this._active;
  }

  start() {
    // Called when SimConnect connects
    this._active = true;
    this._setPhase(PHASE.PRE_FLIGHT);
  }

  stop() {
    // Called when SimConnect disconnects
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
    this._lastData = data;

    // Track maximums
    if (data.altitude > this._maxAlt) this._maxAlt = data.altitude;
    if (data.gForce > this._maxGForce) this._maxGForce = data.gForce;
    if (this._fuelAtStart === null) this._fuelAtStart = data.fuelGallons;

    // Store route point
    const now = Date.now();
    if (now - this._lastRouteAt > DATA_INTERVAL_MS) {
      this._routePoints.push({
        lat:  data.lat,
        lon:  data.lon,
        alt:  data.altitude,
        ts:   now,
      });
      this._lastRouteAt = now;
    }

    this._runStateMachine(data);
    this._prevOnGround = data.onGround;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  _runStateMachine(d) {
    const enginesOn = d.eng1 || d.eng2;

    switch (this._phase) {
      case PHASE.IDLE:
        // Waiting
        break;

      case PHASE.PRE_FLIGHT:
        if (enginesOn && d.onGround) {
          this._setPhase(PHASE.TAXI);
          this._departureIcao = this._airports.nearest(d.lat, d.lon);
          this._fuelAtStart   = d.fuelGallons;
          this._resetFlightRecord();
        }
        break;

      case PHASE.TAXI:
        if (!enginesOn) {
          // Engines cut back on ground – back to pre-flight
          this._setPhase(PHASE.PRE_FLIGHT);
        } else if (d.groundSpeed > TAKEOFF_IAS_KT && d.onGround) {
          this._setPhase(PHASE.TAKEOFF_ROLL);
        }
        break;

      case PHASE.TAKEOFF_ROLL:
        if (!d.onGround) {
          // Wheels off ground
          this._takeoffTime = Date.now();
          this._setPhase(PHASE.AIRBORNE);
          const airport = this._departureIcao;
          this.emit('takeoff', {
            airport,
            ias:  d.ias,
            time: this._takeoffTime,
          });
        } else if (d.groundSpeed < 10) {
          // Aborted takeoff
          this._setPhase(PHASE.TAXI);
        }
        break;

      case PHASE.AIRBORNE:
        if (d.vs > VS_CLIMB_FPM) {
          this._setPhase(PHASE.CLIMB);
        } else if (d.onGround && !this._prevOnGround) {
          // Touched down immediately – touch-and-go?
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
        if (d.vs < VS_DESCENT_FPM) {
          this._setPhase(PHASE.DESCENT);
        }
        break;

      case PHASE.DESCENT:
        if (d.altitude < APPROACH_ALT_FT && d.vs < VS_DESCENT_FPM) {
          this._setPhase(PHASE.APPROACH);
        } else if (d.vs > VS_CLIMB_FPM) {
          // Went back up – step climb or missed approach
          this._setPhase(PHASE.CLIMB);
        } else if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        }
        break;

      case PHASE.APPROACH:
        if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        } else if (d.vs > VS_CLIMB_FPM) {
          // Go-around
          this._setPhase(PHASE.CLIMB);
        }
        break;

      case PHASE.LANDING:
        if (d.groundSpeed < LANDING_GS_KT) {
          this._setPhase(PHASE.POST_FLIGHT);
        }
        break;

      case PHASE.POST_FLIGHT:
        if (!enginesOn) {
          if (!this._enginesOffAt) {
            this._enginesOffAt = Date.now();
          } else if (Date.now() - this._enginesOffAt > ENGINES_OFF_TIMEOUT) {
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
    this._touchdownVs   = d.vs;
    this._arrivalIcao   = this._airports.nearest(d.lat, d.lon);
    this._fuelAtEnd     = d.fuelGallons;
    this._setPhase(PHASE.LANDING);

    this.emit('landing', {
      airport:     this._arrivalIcao,
      landingRate: Math.round(d.vs),
      gForce:      d.gForce,
      time:        Date.now(),
    });
  }

  _completeFlight(d) {
    if (!this._takeoffTime) return; // No takeoff recorded – nothing to report

    const landingTime = Date.now();
    const durationMs  = landingTime - this._takeoffTime;
    const durationMin = Math.round(durationMs / 60000);

    const fuelUsed = this._fuelAtStart !== null && this._fuelAtEnd !== null
      ? Math.round((this._fuelAtStart - this._fuelAtEnd) * 10) / 10
      : null;

    const record = {
      sessionDate:  new Date().toISOString().split('T')[0],
      aircraft:     this._detectAircraftType(),
      departure:    this._departureIcao,
      arrival:      this._arrivalIcao,
      duration:     durationMin,
      landingRate:  Math.round(this._touchdownVs),
      maxAltitude:  this._maxAlt,
      maxGForce:    Math.round(this._maxGForce * 100) / 100,
      fuelUsed,
      routePoints:  this._routePoints,
      simVersion:   'MSFS 2020/2024',
      source:       'simconnect',
    };

    this.emit('flightComplete', record);
    this._resetFlightRecord();
  }

  _detectAircraftType() {
    // We don't read the aircraft title SimVar in the data polling def for performance.
    // A simple approach: return a placeholder; a future enhancement can request
    // ATC_MODEL once per flight via a separate one-off SimConnect request.
    return 'UNKN';
  }

  _resetFlightRecord() {
    this._flightRecord  = null;
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
    this.emit('phase', { phase, prev });
  }

  getCurrentPhase() {
    return this._phase;
  }
}

module.exports = FlightTracker;
