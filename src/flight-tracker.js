'use strict';

/**
 * FlightTracker
 *
 * Receives raw SimConnect data frames and produces higher-level flight events:
 *  - phase changes
 *  - takeoff event (airport, time, IAS)
 *  - landing event (airport, landing rate in fpm, G-force, touchdownZoneHit)
 *  - flightComplete event (full flight record with air time, ground time, touchdown zone)
 *
 * Time tracking:
 *  - Block time OUT: engines first start on ground (TAXI phase entry)
 *  - Wheels up: aircraft lifts off (TAKEOFF_ROLL → AIRBORNE)
 *  - Wheels down: touchdown (onGround transitions to true)
 *  - Block time IN: engines shut down (POST_FLIGHT → engines off timeout)
 *
 *  Air time   = wheelsDown - wheelsUp (hours)
 *  Ground time = (wheelsUp - blockOut) + (blockIn - wheelsDown) (hours)
 *
 * Touchdown zone detection:
 *  - During APPROACH, when AGL drops below THRESHOLD_AGL_FT, record position
 *    as the threshold crossing point.
 *  - At touchdown, compute haversine distance from threshold crossing to touchdown.
 *  - If distance ≤ TOUCHDOWN_ZONE_FT feet (~460m), mark touchdownZoneHit = true.
 *    Touchdown zone = first 1000–1500 ft past the threshold markers.
 *
 * Flight phase state machine:
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

// Touchdown zone detection
const THRESHOLD_AGL_FT      = 80;   // AGL below which we record "threshold crossing"
const TOUCHDOWN_ZONE_FT     = 1500; // max feet from threshold to count as in-zone

/**
 * Haversine distance between two lat/lon points, returned in feet.
 */
function haversineDistanceFt(lat1, lon1, lat2, lon2) {
  const R   = 20902231; // Earth radius in feet
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a   = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180)
            * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class FlightTracker extends EventEmitter {
  constructor() {
    super();

    this._active        = false;
    this._phase         = PHASE.IDLE;
    this._lastData      = null;
    this._prevOnGround  = true;
    this._enginesOffAt  = null;

    // Flight record being built
    this._flightRecord  = null;
    this._routePoints   = [];
    this._lastRouteAt   = 0;
    this._maxAlt        = 0;
    this._maxGForce     = 0;
    this._fuelAtStart   = null;
    this._fuelAtEnd     = null;
    this._departureIcao = null;
    this._arrivalIcao   = null;

    // Detailed time tracking
    this._blockOutTime  = null; // ms timestamp — engines start on ground
    this._wheelsUpTime  = null; // ms timestamp — liftoff
    this._wheelsDownTime = null; // ms timestamp — touchdown
    this._blockInTime   = null; // ms timestamp — engines off after landing

    // Touchdown zone detection
    this._touchdownVs          = 0;
    this._thresholdCrossedPos  = null; // { lat, lon } when AGL < THRESHOLD_AGL_FT in approach
    this._touchdownPos         = null; // { lat, lon } at touchdown
    this._touchdownZoneHit     = false;

    // Bounce detection
    this._bounces          = [];       // [{ timestamp, airTimeMs }]
    this._lastLiftoffTime  = null;     // ms timestamp of last liftoff (for bounce window)

    // Tail strike & touchdown details
    this._tailStrike           = false;
    this._tailStrikeTimestamp  = null;
    this._touchdownPitch       = 0;
    this._touchdownGForce      = 0;

    this._airports = new Airports();
  }

  isTracking() {
    return this._active;
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
    this._lastData = data;

    if (data.altitude > this._maxAlt) this._maxAlt = data.altitude;
    if (data.gForce > this._maxGForce) this._maxGForce = data.gForce;
    if (this._fuelAtStart === null) this._fuelAtStart = data.fuelGallons;

    const now = Date.now();
    if (now - this._lastRouteAt > DATA_INTERVAL_MS) {
      this._routePoints.push({ lat: data.lat, lon: data.lon, alt: data.altitude, ts: now });
      this._lastRouteAt = now;
      // Cap at ~6 hours of data (10s interval × 2160 = 6 h) to bound memory
      if (this._routePoints.length > 2160) this._routePoints.shift();
    }

    // Touchdown zone: track threshold crossing during approach
    if (this._phase === PHASE.APPROACH && !data.onGround) {
      const agl = data.altAgl ?? 999;
      if (agl < THRESHOLD_AGL_FT && this._thresholdCrossedPos === null) {
        this._thresholdCrossedPos = { lat: data.lat, lon: data.lon };
      }
    }

    // Bounce detection: track liftoff/touchdown transitions after initial takeoff
    if (!data.onGround && this._prevOnGround && this._wheelsUpTime !== null) {
      // Re-airborne after a previous takeoff — could be a bounce
      this._lastLiftoffTime = Date.now();
    }
    if (data.onGround && !this._prevOnGround && this._lastLiftoffTime !== null) {
      const timeAirborne = Date.now() - this._lastLiftoffTime;
      if (timeAirborne < 3000) {
        this._bounces.push({ timestamp: Date.now(), airTimeMs: timeAirborne });
      }
      this._lastLiftoffTime = null;
    }

    // Tail strike detection: pitch > 12° while on the ground
    if (data.onGround && data.pitch !== undefined && data.pitch > 12 && !this._tailStrike) {
      this._tailStrike = true;
      this._tailStrikeTimestamp = Date.now();
    }

    this._runStateMachine(data);
    this._prevOnGround = data.onGround;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  _runStateMachine(d) {
    const enginesOn = d.eng1 || d.eng2;

    switch (this._phase) {
      case PHASE.IDLE:
        break;

      case PHASE.PRE_FLIGHT:
        if (enginesOn && d.onGround) {
          this._blockOutTime = Date.now();
          this._fuelAtStart  = d.fuelGallons;
          this._resetFlightRecord(/* keepBlockOut= */ true);
          // Must assign AFTER _resetFlightRecord() because that method clears _departureIcao
          this._departureIcao = this._airports.nearest(d.lat, d.lon);
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
          this._wheelsUpTime = Date.now();
          this._setPhase(PHASE.AIRBORNE);
          this.emit('takeoff', { airport: this._departureIcao, ias: d.ias, time: this._wheelsUpTime });
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
        if (d.vs < VS_DESCENT_FPM) {
          this._setPhase(PHASE.DESCENT);
        }
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
          // Go-around — reset threshold crossing
          this._thresholdCrossedPos = null;
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
            this._blockInTime = Date.now();
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
    this._touchdownVs    = d.vs;
    this._wheelsDownTime = Date.now();
    this._arrivalIcao    = this._airports.nearest(d.lat, d.lon);
    this._fuelAtEnd      = d.fuelGallons;
    this._touchdownPos   = { lat: d.lat, lon: d.lon };
    this._touchdownPitch  = d.pitch  ?? 0;
    this._touchdownGForce = d.gForce ?? 0;

    // Tail strike: also catch high pitch exactly at touchdown
    if (d.pitch !== undefined && d.pitch > 12 && !this._tailStrike) {
      this._tailStrike = true;
      this._tailStrikeTimestamp = Date.now();
    }

    // Determine touchdown zone hit
    if (this._thresholdCrossedPos) {
      const distFt = haversineDistanceFt(
        this._thresholdCrossedPos.lat, this._thresholdCrossedPos.lon,
        d.lat, d.lon
      );
      this._touchdownZoneHit = distFt <= TOUCHDOWN_ZONE_FT;
    } else {
      // No threshold crossing recorded (e.g., visual approach at high AGL)
      // Fall back: if AGL at touchdown area was very low at threshold we estimate
      // Using VS as proxy: typical TZ approach has specific descent profile
      // Without data, conservatively mark as unknown (false)
      this._touchdownZoneHit = false;
    }

    this._setPhase(PHASE.LANDING);

    this.emit('landing', {
      airport:          this._arrivalIcao,
      landingRate:      Math.round(d.vs),
      gForce:           d.gForce,
      touchdownZoneHit: this._touchdownZoneHit,
      time:             this._wheelsDownTime,
    });
  }

  _completeFlight(d) {
    if (!this._wheelsUpTime) return; // No takeoff recorded

    const now = Date.now();

    // Air time: wheels up → wheels down
    const wheelsDown   = this._wheelsDownTime ?? now;
    const airTimeMs    = wheelsDown - this._wheelsUpTime;
    const airTimeMin   = Math.round(airTimeMs / 60000);
    const airTimeHours = airTimeMin / 60;

    // Ground time: block out → wheels up  +  wheels down → block in (engines off)
    const blockOut     = this._blockOutTime ?? (this._wheelsUpTime - 15 * 60000); // fallback: 15min taxi
    const blockIn      = this._blockInTime  ?? (wheelsDown + 10 * 60000);         // fallback: 10min taxi
    const groundTimeMs = (this._wheelsUpTime - blockOut) + (blockIn - wheelsDown);
    const groundTimeMin  = Math.max(0, Math.round(groundTimeMs / 60000));
    const groundTimeHours = groundTimeMin / 60;

    const durationMin = airTimeMin; // report air time as "duration" for UI

    const fuelUsed = this._fuelAtStart !== null && this._fuelAtEnd !== null
      ? Math.round((this._fuelAtStart - this._fuelAtEnd) * 10) / 10
      : null;

    const record = {
      sessionDate:      new Date().toISOString().split('T')[0],
      aircraft:         this._detectAircraftType(),
      departure:        this._departureIcao,
      arrival:          this._arrivalIcao,
      duration:         durationMin,          // air time in minutes
      airTime:          airTimeHours,         // hours
      groundTime:       groundTimeHours,      // hours
      landingRate:      Math.round(this._touchdownVs),
      touchdownZoneHit: this._touchdownZoneHit,
      touchdownPitch:   this._touchdownPitch,
      touchdownGForce:  this._touchdownGForce,
      bounces:          this._bounces.length,
      bounceTimestamps: this._bounces.map(b => b.timestamp),
      tailStrike:       this._tailStrike,
      maxAltitude:      this._maxAlt,
      maxGForce:        Math.round(this._maxGForce * 100) / 100,
      fuelUsed,
      routePoints:      this._routePoints,
      simVersion:       'MSFS 2020/2024',
      source:           'simconnect',
    };

    this.emit('flightComplete', record);
    this._resetFlightRecord();
  }

  _detectAircraftType() {
    return 'UNKN';
  }

  /**
   * @param {boolean} keepBlockOut - if true, preserve _blockOutTime through reset
   */
  _resetFlightRecord(keepBlockOut = false) {
    const savedBlockOut = keepBlockOut ? this._blockOutTime : null;

    this._flightRecord       = null;
    this._routePoints        = [];
    this._lastRouteAt        = 0;
    this._maxAlt             = 0;
    this._maxGForce          = 0;
    this._fuelAtStart        = null;
    this._fuelAtEnd          = null;
    this._departureIcao      = null;
    this._arrivalIcao        = null;
    this._touchdownVs        = 0;
    this._wheelsUpTime       = null;
    this._wheelsDownTime     = null;
    this._blockInTime        = null;
    this._thresholdCrossedPos = null;
    this._touchdownPos       = null;
    this._touchdownZoneHit   = false;
    this._touchdownPitch     = 0;
    this._touchdownGForce    = 0;
    this._bounces            = [];
    this._lastLiftoffTime    = null;
    this._tailStrike         = false;
    this._tailStrikeTimestamp = null;

    this._blockOutTime = savedBlockOut;
  }

  _setPhase(phase) {
    if (this._phase === phase) return;
    const prev = this._phase;
    this._phase = phase;
    this.emit('phase', { phase, prev });

    // High-frequency polling: enable near landing, disable once clear
    if (phase === PHASE.APPROACH) {
      this.emit('highFreq', { enabled: true });
    } else if (phase === PHASE.POST_FLIGHT || phase === PHASE.TAXI) {
      this.emit('highFreq', { enabled: false });
    }
  }

  getCurrentPhase() {
    return this._phase;
  }
}

module.exports = FlightTracker;
