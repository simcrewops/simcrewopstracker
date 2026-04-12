'use strict';

/**
 * FlightTracker
 *
 * Receives raw SimConnect data frames and produces higher-level flight events:
 *  - phase changes
 *  - takeoff event (airport, time, IAS)
 *  - landing event (airport, landing rate in fpm, G-force, touchdownZoneHit)
 *  - flightComplete event (full flight record with air time, block time, etc.)
 *
 * ── Block time ────────────────────────────────────────────────────────────────
 *  Blocks OFF: PARKING BRAKE INDICATOR drops 1→0, AND GROUND VELOCITY exceeds
 *              0.5 kt within the following 30 seconds.  Timestamped at brake
 *              release (not at movement detection) as blocksOffTime.
 *
 *  Blocks ON:  After a landing has been recorded, aircraft is on the ground,
 *              GROUND VELOCITY < 0.5 kt, AND PARKING BRAKE INDICATOR = 1.
 *              Timestamped as blocksOnTime.
 *
 *  Block time for pay = blocksOnTime − blocksOffTime (decimal hours).
 *
 *  Engine start is tracked separately as engineStartTime (ENG COMBUSTION:1
 *  transitions 0→1) and stored on the flight record, but is NOT used as the
 *  block time trigger.
 *
 *  Both blocksOffTime and engineStartTime survive a SimConnect
 *  disconnect/reconnect — stop() does not reset them.
 *
 * ── Phase state machine ───────────────────────────────────────────────────────
 *   IDLE → PRE_FLIGHT → TAXI → TAKEOFF_ROLL → AIRBORNE → CLIMB
 *        → CRUISE → DESCENT → APPROACH → LANDING → POST_FLIGHT → IDLE
 *
 * ── Touchdown zone detection ──────────────────────────────────────────────────
 *  During APPROACH, when AGL drops below THRESHOLD_AGL_FT, record position as
 *  the threshold crossing.  At touchdown, compute haversine distance; if ≤
 *  TOUCHDOWN_ZONE_FT mark touchdownZoneHit = true.
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
const TAKEOFF_IAS_KT        = 60;    // GS above which takeoff roll is declared
const LANDING_GS_KT         = 10;    // GS below which we consider fully stopped
const CRUISE_ALT_FT         = 10000; // Alt above which (level) = cruise
const APPROACH_ALT_FT       = 5000;  // Alt below which (descending) = approach
const VS_CLIMB_FPM          = 200;
const VS_DESCENT_FPM        = -200;
const ENGINES_OFF_TIMEOUT   = 30000; // ms engines must be off → complete flight
const DATA_INTERVAL_MS      = 10000; // route point every 10 s

const CLIMB_AGL_GATE_FT     = 400;   // AGL above which we leave AIRBORNE→CLIMB

// Touchdown zone
const THRESHOLD_AGL_FT      = 80;
const TOUCHDOWN_ZONE_FT     = 1500;

// Block time
const BLOCKS_OFF_WINDOW_MS  = 30000; // PB release → movement must happen within 30 s
const BLOCKS_ON_GS_KT       = 0.5;  // ground speed threshold for blocks-on
const BLOCKS_OFF_GS_KT      = 0.5;  // ground speed threshold confirming blocks-off

function haversineDistanceFt(lat1, lon1, lat2, lon2) {
  const R   = 20902231;
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

    // Flight record fields
    this._flightRecord   = null;
    this._routePoints    = [];
    this._lastRouteAt    = 0;
    this._maxAlt         = 0;
    this._maxGForce      = 0;
    this._fuelAtStart    = null;
    this._fuelAtEnd      = null;
    this._departureIcao  = null;
    this._arrivalIcao    = null;

    // Time tracking
    this._blockOutTime   = null; // ms — parking brake release + movement confirmed
    this._blocksOnTime   = null; // ms — parking brake set at dest + stopped, after landing
    this._wheelsUpTime   = null; // ms — liftoff
    this._wheelsDownTime = null; // ms — touchdown

    // Engine start (separate from block time, tracked for the flight record)
    this._engineStartTime = null; // ms — first ENG COMBUSTION:1 0→1 transition
    this._prevEng1        = false;

    // Parking-brake block-time tracking
    this._prevParkingBrake        = true;  // assume set at startup
    this._parkingBrakeReleasedAt  = null;  // ms — when PB was released (window start)

    this._resumedMidFlight = false;

    // Touchdown zone
    this._touchdownVs          = 0;
    this._thresholdCrossedPos  = null;
    this._touchdownPos         = null;
    this._touchdownZoneHit     = false;

    // Bounce detection
    this._bounces          = [];
    this._lastLiftoffTime  = null;

    // Tail strike & touchdown details
    this._tailStrike           = false;
    this._tailStrikeTimestamp  = null;
    this._touchdownPitch       = 0;
    this._touchdownGForce      = 0;

    this._airports = new Airports();
    this._aircraftTypeCode = null;
  }

  isTracking() {
    return this._active;
  }

  start() {
    this._active = true;
    this._setPhase(PHASE.PRE_FLIGHT);
  }

  stop() {
    // Intentionally does NOT reset the flight record — block times and
    // in-progress state must survive a SimConnect disconnect/reconnect.
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

  resumeMidFlight(data) {
    this._active           = true;
    this._resumedMidFlight = true;
    this._fuelAtStart      = data.fuelLbs;
    this._wheelsUpTime     = Date.now();

    let targetPhase;
    if (data.vs > VS_CLIMB_FPM) {
      targetPhase = PHASE.CLIMB;
    } else if (data.vs < VS_DESCENT_FPM) {
      targetPhase = data.altitude < APPROACH_ALT_FT ? PHASE.APPROACH : PHASE.DESCENT;
    } else {
      targetPhase = PHASE.CRUISE;
    }

    this._setPhase(targetPhase);
    this.emit('midFlightResume', { phase: targetPhase });
  }

  update(data) {
    if (!this._active) return;

    // Skip full tracking logic during core-only warmup — engine and brake data
    // aren't available yet, and running the state machine on defaults would
    // produce incorrect phase transitions.
    if (data.coreOnly) {
      this._lastData = data;
      return;
    }

    this._lastData = data;

    if (data.altitude > this._maxAlt) this._maxAlt = data.altitude;
    if (data.gForce > this._maxGForce) this._maxGForce = data.gForce;
    if (this._fuelAtStart === null && data.fuelLbs !== null) {
      this._fuelAtStart = data.fuelLbs;
    }

    const now = Date.now();
    if (now - this._lastRouteAt > DATA_INTERVAL_MS) {
      this._routePoints.push({ lat: data.lat, lon: data.lon, alt: data.altitude, ts: now });
      this._lastRouteAt = now;
      if (this._routePoints.length > 2160) this._routePoints.shift();
    }

    // ── Engine start tracking ────────────────────────────────────────────────
    // Record the first time ENG COMBUSTION:1 transitions 0 → 1.
    if (!this._engineStartTime && !this._prevEng1 && data.eng1) {
      this._engineStartTime = now;
    }
    this._prevEng1 = data.eng1;

    // ── Blocks-off tracking ──────────────────────────────────────────────────
    // Step 1: detect parking brake 1→0 transition
    if (this._prevParkingBrake && !data.parkingBrake && !this._parkingBrakeReleasedAt && !this._blockOutTime) {
      this._parkingBrakeReleasedAt = now;
    }
    // Step 2: confirm movement within 30-second window
    if (this._parkingBrakeReleasedAt && !this._blockOutTime) {
      if (data.groundSpeed > BLOCKS_OFF_GS_KT) {
        // Blocks-off time = the moment the brake was released, not movement onset
        this._blockOutTime = this._parkingBrakeReleasedAt;
        this._parkingBrakeReleasedAt = null;
      } else if (now - this._parkingBrakeReleasedAt > BLOCKS_OFF_WINDOW_MS) {
        // No movement within 30 s — discard (e.g., brief accidental release)
        this._parkingBrakeReleasedAt = null;
      }
    }
    this._prevParkingBrake = data.parkingBrake;

    // ── Blocks-on tracking ───────────────────────────────────────────────────
    // Only after a landing has been recorded (wheelsDownTime set).
    if (!this._blocksOnTime && this._wheelsDownTime &&
        data.onGround && data.groundSpeed < BLOCKS_ON_GS_KT && data.parkingBrake) {
      this._blocksOnTime = now;
    }

    // ── Touchdown zone threshold crossing ───────────────────────────────────
    if (this._phase === PHASE.APPROACH && !data.onGround) {
      const agl = data.altAgl ?? 999;
      if (agl < THRESHOLD_AGL_FT && this._thresholdCrossedPos === null) {
        this._thresholdCrossedPos = { lat: data.lat, lon: data.lon };
      }
    }

    // ── Bounce detection ────────────────────────────────────────────────────
    if (!data.onGround && this._prevOnGround && this._wheelsUpTime !== null) {
      this._lastLiftoffTime = now;
    }
    if (data.onGround && !this._prevOnGround && this._lastLiftoffTime !== null) {
      const timeAirborne = now - this._lastLiftoffTime;
      if (timeAirborne < 3000) {
        this._bounces.push({ timestamp: now, airTimeMs: timeAirborne });
      }
      this._lastLiftoffTime = null;
    }

    // ── Tail strike ──────────────────────────────────────────────────────────
    if (data.onGround && data.pitch !== undefined && data.pitch > 12 && !this._tailStrike) {
      this._tailStrike = true;
      this._tailStrikeTimestamp = now;
    }

    this._runStateMachine(data);
    this._prevOnGround = data.onGround;
  }

  // ── State machine ──────────────────────────────────────────────────────────
  _runStateMachine(d) {
    const enginesOn = d.eng1 || d.eng2;

    switch (this._phase) {
      case PHASE.IDLE:
        break;

      case PHASE.PRE_FLIGHT:
        if (enginesOn && d.onGround) {
          this._fuelAtStart = d.fuelLbs;
          // keepBlockOut=true preserves any PB-based blocksOffTime already set;
          // also preserves engineStartTime recorded in update() above.
          this._resetFlightRecord(/* keepBlockOut= */ true);
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
        if (d.vs > VS_CLIMB_FPM || (d.altAgl ?? 0) > CLIMB_AGL_GATE_FT) {
          this._setPhase(PHASE.CLIMB);
        } else if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        }
        break;

      case PHASE.CLIMB:
        if (d.altitude > CRUISE_ALT_FT && d.vs < VS_CLIMB_FPM && d.vs > VS_DESCENT_FPM) {
          this._setPhase(PHASE.CRUISE);
        } else if (d.vs < VS_DESCENT_FPM) {
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
    this._fuelAtEnd      = d.fuelLbs;
    this._touchdownPos   = { lat: d.lat, lon: d.lon };
    this._touchdownPitch  = d.pitch  ?? 0;
    this._touchdownGForce = d.gForce ?? 0;

    if (d.pitch !== undefined && d.pitch > 12 && !this._tailStrike) {
      this._tailStrike = true;
      this._tailStrikeTimestamp = Date.now();
    }

    if (this._thresholdCrossedPos) {
      const distFt = haversineDistanceFt(
        this._thresholdCrossedPos.lat, this._thresholdCrossedPos.lon,
        d.lat, d.lon
      );
      this._touchdownZoneHit = distFt <= TOUCHDOWN_ZONE_FT;
    } else {
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
    if (!this._wheelsUpTime) return;

    const now = Date.now();

    // Air time: wheels up → wheels down
    const wheelsDown   = this._wheelsDownTime ?? now;
    const airTimeMs    = wheelsDown - this._wheelsUpTime;
    const airTimeMin   = Math.round(airTimeMs / 60000);
    const airTimeHours = airTimeMin / 60;

    // Block time: blocks-off → blocks-on (parking-brake-based).
    // Fallback to engine-era estimates only if PB timestamps unavailable.
    const blockOut      = this._blockOutTime  ?? (this._wheelsUpTime - 15 * 60000);
    const blockIn       = this._blocksOnTime  ?? (wheelsDown + 10 * 60000);
    const blockTimeMs   = blockIn - blockOut;
    const blockTimeMin  = Math.max(0, Math.round(blockTimeMs / 60000));
    const blockTimeHours = blockTimeMin / 60;

    // Ground time = block time − air time
    const groundTimeMs    = Math.max(0, blockTimeMs - airTimeMs);
    const groundTimeMin   = Math.round(groundTimeMs / 60000);
    const groundTimeHours = groundTimeMin / 60;

    // Fuel used in pounds (FUEL TOTAL QUANTITY WEIGHT SimVar)
    const fuelUsedLbs = this._fuelAtStart !== null && this._fuelAtEnd !== null
      ? Math.round(this._fuelAtStart - this._fuelAtEnd)
      : null;

    const record = {
      sessionDate:      new Date().toISOString().split('T')[0],
      aircraft:         this._detectAircraftType(),
      departure:        this._departureIcao,
      arrival:          this._arrivalIcao,
      resumedMidFlight: this._resumedMidFlight,
      duration:         airTimeMin,
      airTime:          airTimeHours,
      groundTime:       groundTimeHours,
      blockTime:        blockTimeHours,
      // Raw timestamps (ms since epoch) for server-side calculation
      blocksOffTime:    this._blockOutTime  ?? null,
      blocksOnTime:     this._blocksOnTime  ?? null,
      engineStartTime:  this._engineStartTime ?? null,
      wheelsUpTime:     this._wheelsUpTime,
      wheelsDownTime:   this._wheelsDownTime,
      landingRate:      Math.round(this._touchdownVs),
      touchdownZoneHit: this._touchdownZoneHit,
      touchdownPitch:   this._touchdownPitch,
      touchdownGForce:  this._touchdownGForce,
      bounces:          this._bounces.length,
      bounceTimestamps: this._bounces.map(b => b.timestamp),
      tailStrike:       this._tailStrike,
      maxAltitude:      this._maxAlt,
      maxGForce:        Math.round(this._maxGForce * 100) / 100,
      fuelUsed:     fuelUsedLbs,   // pounds
      fuelUsedLbs,                 // alias — explicit unit
      routePoints:      this._routePoints,
      simVersion:       'MSFS 2020/2024',
      source:           'simconnect',
    };

    this.emit('flightComplete', record);
    this._resetFlightRecord();
  }

  setAircraftType(typeCode) {
    this._aircraftTypeCode = typeCode ? typeCode.trim() : null;
  }

  _detectAircraftType() {
    return this._aircraftTypeCode ?? 'UNKN';
  }

  /**
   * Reset all per-flight state.
   *
   * @param {boolean} keepBlockOut - When true, preserve _blockOutTime and
   *   _engineStartTime across the reset.  Used when the state machine re-enters
   *   PRE_FLIGHT (e.g. engines restart) so block-out recorded at PB release
   *   is not lost.
   */
  _resetFlightRecord(keepBlockOut = false) {
    const savedBlockOut    = keepBlockOut ? this._blockOutTime    : null;
    const savedEngStart    = keepBlockOut ? this._engineStartTime : null;

    this._resumedMidFlight    = false;
    this._flightRecord        = null;
    this._routePoints         = [];
    this._lastRouteAt         = 0;
    this._maxAlt              = 0;
    this._maxGForce           = 0;
    this._fuelAtStart         = null;
    this._fuelAtEnd           = null;
    this._departureIcao       = null;
    this._arrivalIcao         = null;
    this._touchdownVs         = 0;
    this._wheelsUpTime        = null;
    this._wheelsDownTime      = null;
    this._blocksOnTime        = null;
    this._thresholdCrossedPos = null;
    this._touchdownPos        = null;
    this._touchdownZoneHit    = false;
    this._touchdownPitch      = 0;
    this._touchdownGForce     = 0;
    this._bounces             = [];
    this._lastLiftoffTime     = null;
    this._tailStrike          = false;
    this._tailStrikeTimestamp = null;
    this._parkingBrakeReleasedAt = null;

    // Restore preserved values (or clear on full stop)
    this._blockOutTime    = savedBlockOut;
    this._engineStartTime = savedEngStart;
  }

  _setPhase(phase) {
    if (this._phase === phase) return;
    const prev = this._phase;
    this._phase = phase;
    this.emit('phase', { phase, prev });

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
