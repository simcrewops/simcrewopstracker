'use strict';

/**
 * FlightTracker
 *
 * Receives raw SimConnect data frames and produces higher-level flight events:
 *  - phase changes
 *  - takeoff event (airport, time, IAS)
 *  - landing event (airport, landing rate in fpm, G-force, touchdownZoneHit)
 *  - flightComplete event (full flight record with scoring subfields)
 *
 * Flight phase state machine:
 *   IDLE → PRE_FLIGHT → TAXI → TAKEOFF_ROLL → AIRBORNE → CLIMB
 *        → CRUISE → DESCENT → APPROACH → LANDING → POST_FLIGHT → IDLE
 */

const { EventEmitter } = require('events');
const Airports = require('./airports');
const { getAircraftSpeeds } = require('./aircraft-speeds');

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

// ── Phase transition thresholds ───────────────────────────────────────────────
const TAKEOFF_IAS_KT      = 60;
const LANDING_GS_KT       = 10;
const CRUISE_ALT_FT       = 10000;
const APPROACH_ALT_FT     = 5000;
const VS_CLIMB_FPM        = 200;
const VS_DESCENT_FPM      = -200;
const ENGINES_OFF_TIMEOUT = 30000;
const DATA_INTERVAL_MS    = 10000;
const CLIMB_AGL_GATE_FT   = 400;

// ── Touchdown zone detection ──────────────────────────────────────────────────
const THRESHOLD_AGL_FT  = 80;
const TOUCHDOWN_ZONE_FT = 1500;

// ── Scoring thresholds ────────────────────────────────────────────────────────
const MAX_TAXI_SPEED_KT         = 40;
const MAX_TURN_SPEED_KT         = 15;   // max GS on a turn > 45°
const TURN_HEADING_DELTA_DEG    = 45;   // cumulative heading change that counts as a "turn"
const TAIL_STRIKE_PITCH_DEG     = 10;   // pitch on ground → tail strike
const MAX_BANK_NORMAL_DEG       = 30;   // takeoff / climb / cruise / descent
const MAX_BANK_APPROACH_DEG     = 10;   // stabilised approach
const MAX_PITCH_TAKEOFF_DEG     = 20;
const MAX_PITCH_DESCENT_DEG     = 20;
const MAX_PITCH_APPROACH_DEG    = 10;
const SPEED_LIMIT_BELOW_FL100   = 250;  // standard
const SPEED_LIMIT_HEAVY_4ENG    = 300;  // heavy 4-engine exception
const FL180_FT                  = 18000;
const CRUISE_LOCK_MS            = 60000; // wait 60 s before locking cruise FL/mach
const CRUISE_ALT_TOLERANCE_FT   = 100;
const MAX_APPROACH_VS_FPM       = -1000; // stabilised approach: no more than 1000 fpm down
const STABILISED_AGL_FT         = 500;
const GEAR_DOWN_AGL_FT          = 1000;
const FLAPS_SET_AGL_FT          = 1000;

// 4-engine heavy types that get the 300kt below FL100 exception
const HEAVY_4_ENGINE = new Set([
  'B744','B748','B74S','B74F',
  'A380','A388',
  'A340','A342','A343','A345','A346',
  'A3ST',
]);

function isHeavy4Engine(typeCode) {
  if (!typeCode) return false;
  return HEAVY_4_ENGINE.has(typeCode.toUpperCase().trim());
}

/**
 * Haversine distance between two lat/lon points, returned in feet.
 */
function haversineDistanceFt(lat1, lon1, lat2, lon2) {
  const R    = 20902231;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180)
             * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Smallest signed delta between two headings (-180 to +180). */
function headingDelta(a, b) {
  let d = ((b - a) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/** Root-mean-square of an array of numbers. Returns 0 for empty array. */
function rms(values) {
  if (!values.length) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

class FlightTracker extends EventEmitter {
  constructor() {
    super();

    this._active        = false;
    this._phase         = PHASE.IDLE;
    this._lastData      = null;
    this._prevOnGround  = true;
    this._enginesOffAt  = null;

    // Flight record
    this._routePoints   = [];
    this._lastRouteAt   = 0;
    this._maxAlt        = 0;
    this._maxGForce     = 0;
    this._fuelAtStart   = null;
    this._fuelAtEnd     = null;
    this._departureIcao = null;
    this._arrivalIcao   = null;

    // Time tracking
    this._blockOutTime   = null;
    this._wheelsUpTime   = null;
    this._wheelsDownTime = null;
    this._blockInTime    = null;

    this._resumedMidFlight = false;

    // Touchdown / bounce / tail strike
    this._touchdownVs          = 0;
    this._thresholdCrossedPos  = null;
    this._touchdownPos         = null;
    this._touchdownZoneHit     = false;
    this._bounces              = [];
    this._lastLiftoffTime      = null;
    this._tailStrike           = false;
    this._tailStrikeTimestamp  = null;
    this._touchdownPitch       = 0;
    this._touchdownGForce      = 0;

    this._airports        = new Airports();
    this._aircraftTypeCode = null;

    // ── Scoring accumulators ──────────────────────────────────────────────────

    // Pre-flight
    this._beaconOnBeforeTaxi   = false; // was beacon on when TAXI phase entered?

    // Taxi out / taxi in (shared helper, separate stored results)
    this._prevHeading          = null;
    this._turnHeadingAcc       = 0;    // cumulative heading delta building toward a turn
    this._taxiFrameCount       = 0;
    this._taxiLightOnFrames    = 0;

    // Taxi out
    this._taxiOutMaxSpeed      = 0;
    this._taxiOutTurnViolations = 0;
    this._taxiOutLightFraction  = 1.0;

    // Takeoff roll
    this._rotateSpeed           = null; // IAS at wheels-off
    this._landingLightsAtTakeoff = false;
    this._takeoffBankViolations  = 0;
    this._takeoffPitchViolations = 0;

    // Airborne → strobe tracking from takeoff through landing
    this._strobeOffFrames       = 0;
    this._strobeTrackedFrames   = 0;

    // Landing lights: must be ON below FL180, OFF above FL180 after being set on
    this._landingLightsViolation = false; // true if lights not on when they should be, or not off when should be

    // Climb
    this._climbSpeedViolations  = 0;
    this._climbBankViolations   = 0;
    this._climbMaxGForce        = 0;

    // Cruise
    this._cruiseEnteredAt       = null;  // timestamp when CRUISE phase was entered
    this._cruiseAltTarget       = null;  // locked cruise altitude (set after 60s)
    this._cruiseMachLock        = null;  // locked mach (set after 60s)
    this._cruiseMachSamples     = [];    // mach readings after lock for RMS
    this._cruiseAltViolations   = 0;     // frames outside ±100ft of target
    this._cruiseBankViolations  = 0;
    this._cruiseMaxGForce       = 0;
    this._cruiseMachRms         = 0;

    // Descent
    this._descentSpeedViolations = 0;
    this._descentBankViolations  = 0;
    this._descentPitchViolations = 0;
    this._descentMaxGForce       = 0;

    // Approach
    this._approachGsSamples     = [];   // gsDeviation readings for RMS
    this._approachSpeedSamples  = [];   // IAS readings for average approach speed
    this._gearDownBy1000        = false; // gear was down by 1000 AGL
    this._flapsSetBy1000        = false; // flaps > 1 by 1000 AGL
    this._stabilisedBelow500    = false; // all stable criteria met at 500 AGL gate
    this._checkedAt1000         = false;
    this._checkedAt500          = false;

    // Taxi in (POST_FLIGHT)
    this._taxiInMaxSpeed        = 0;
    this._taxiInTurnViolations  = 0;
    this._taxiInLightFraction   = 1.0;
    this._taxiInLandingLightsOff = false; // true if landing lights were off during taxi in
    this._taxiInStrobesOff      = false;  // true if strobes were off during taxi in
    this._taxiInFrameCount      = 0;
    this._taxiInLightOnFrames   = 0;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  isTracking() { return this._active; }

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

  resumeMidFlight(data) {
    this._active           = true;
    this._resumedMidFlight = true;
    this._fuelAtStart      = data.fuelGallons;
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

  setAircraftType(typeCode) {
    this._aircraftTypeCode = typeCode ? typeCode.trim() : null;
  }

  getCurrentPhase() { return this._phase; }

  // ── Main update loop ─────────────────────────────────────────────────────────

  update(data) {
    if (!this._active) return;
    this._lastData = data;

    if (data.altitude > this._maxAlt) this._maxAlt = data.altitude;
    if (data.gForce   > this._maxGForce) this._maxGForce = data.gForce;
    if (this._fuelAtStart === null) this._fuelAtStart = data.fuelGallons;

    const now = Date.now();
    if (now - this._lastRouteAt > DATA_INTERVAL_MS) {
      this._routePoints.push({ lat: data.lat, lon: data.lon, alt: data.altitude, ts: now });
      this._lastRouteAt = now;
      if (this._routePoints.length > 2160) this._routePoints.shift();
    }

    // Touchdown zone threshold crossing
    if (this._phase === PHASE.APPROACH && !data.onGround) {
      const agl = data.altAgl ?? 999;
      if (agl < THRESHOLD_AGL_FT && this._thresholdCrossedPos === null) {
        this._thresholdCrossedPos = { lat: data.lat, lon: data.lon };
      }
    }

    // Bounce detection
    if (!data.onGround && this._prevOnGround && this._wheelsUpTime !== null) {
      this._lastLiftoffTime = Date.now();
    }
    if (data.onGround && !this._prevOnGround && this._lastLiftoffTime !== null) {
      const airMs = Date.now() - this._lastLiftoffTime;
      if (airMs < 3000) this._bounces.push({ timestamp: Date.now(), airTimeMs: airMs });
      this._lastLiftoffTime = null;
    }

    // Tail strike: pitch > 10° on the ground
    if (data.onGround && (data.pitch ?? 0) > TAIL_STRIKE_PITCH_DEG && !this._tailStrike) {
      this._tailStrike          = true;
      this._tailStrikeTimestamp = Date.now();
    }

    // Per-phase scoring accumulation
    this._accumulateScoring(data);

    this._runStateMachine(data);
    this._prevOnGround = data.onGround;
    this._prevHeading  = data.heading;
  }

  // ── Per-frame scoring accumulation ──────────────────────────────────────────

  _accumulateScoring(d) {
    const phase = this._phase;
    const abs   = Math.abs;

    // ── Taxi out ────────────────────────────────────────────────────────────
    if (phase === PHASE.TAXI) {
      if (d.groundSpeed > this._taxiOutMaxSpeed) this._taxiOutMaxSpeed = d.groundSpeed;
      this._taxiFrameCount++;
      if (d.lightTaxi) this._taxiLightOnFrames++;
      this._checkTurnSpeed(d, 'out');
    }

    // ── Takeoff roll ────────────────────────────────────────────────────────
    if (phase === PHASE.TAKEOFF_ROLL) {
      if (abs(d.bankAngle ?? 0) > MAX_BANK_NORMAL_DEG)  this._takeoffBankViolations++;
      if ((d.pitch ?? 0)        > MAX_PITCH_TAKEOFF_DEG) this._takeoffPitchViolations++;
    }

    // ── Strobe: must be on from AIRBORNE through end of LANDING ────────────
    const strobePhases = [
      PHASE.AIRBORNE, PHASE.CLIMB, PHASE.CRUISE,
      PHASE.DESCENT, PHASE.APPROACH, PHASE.LANDING,
    ];
    if (strobePhases.includes(phase)) {
      this._strobeTrackedFrames++;
      if (!d.lightStrobe) this._strobeOffFrames++;
    }

    // ── Landing lights ─────────────────────────────────────────────────────
    // Must be ON  : TAKEOFF_ROLL onward until FL180
    // Must be OFF : above FL180
    // Must be ON  : below FL180 again (DESCENT / APPROACH / LANDING)
    if (phase === PHASE.CLIMB || phase === PHASE.AIRBORNE) {
      if (d.altitude >= FL180_FT && d.lightLanding) {
        // Still on above FL180 — violation
        this._landingLightsViolation = true;
      }
    }
    // Landing lights must be ON below FL180 during descent and approach.
    // LANDING (rollout) is excluded — pilot correctly turns them off after touchdown.
    if (phase === PHASE.DESCENT || phase === PHASE.APPROACH) {
      if (d.altitude < FL180_FT && !d.lightLanding) {
        this._landingLightsViolation = true;
      }
    }

    // ── Climb scoring ───────────────────────────────────────────────────────
    if (phase === PHASE.CLIMB) {
      const limit = isHeavy4Engine(this._aircraftTypeCode)
        ? SPEED_LIMIT_HEAVY_4ENG : SPEED_LIMIT_BELOW_FL100;
      if (d.altitude < 10000 && d.ias > limit) this._climbSpeedViolations++;
      if (abs(d.bankAngle ?? 0) > MAX_BANK_NORMAL_DEG) this._climbBankViolations++;
      if ((d.gForce ?? 0) > this._climbMaxGForce) this._climbMaxGForce = d.gForce;
    }

    // ── Cruise scoring ──────────────────────────────────────────────────────
    if (phase === PHASE.CRUISE) {
      const elapsed = Date.now() - (this._cruiseEnteredAt ?? Date.now());

      if (elapsed >= CRUISE_LOCK_MS) {
        // Lock FL and mach on first frame past 60s
        if (this._cruiseAltTarget === null) {
          this._cruiseAltTarget = d.altitude;
          this._cruiseMachLock  = d.mach;
        }

        // Altitude hold
        if (abs(d.altitude - this._cruiseAltTarget) > CRUISE_ALT_TOLERANCE_FT) {
          // Auto-detect a deliberate step climb: if > 500ft off for > 60s, re-lock
          this._cruiseAltViolations++;
        }

        // Mach stability — collect samples for RMS
        if (d.mach > 0.1) {
          this._cruiseMachSamples.push(d.mach - this._cruiseMachLock);
        }
      }

      if (abs(d.bankAngle ?? 0) > MAX_BANK_NORMAL_DEG) this._cruiseBankViolations++;
      if ((d.gForce ?? 0) > this._cruiseMaxGForce) this._cruiseMaxGForce = d.gForce;
    }

    // ── Descent scoring ─────────────────────────────────────────────────────
    if (phase === PHASE.DESCENT) {
      const limit = isHeavy4Engine(this._aircraftTypeCode)
        ? SPEED_LIMIT_HEAVY_4ENG : SPEED_LIMIT_BELOW_FL100;
      if (d.altitude < 10000 && d.ias > limit) this._descentSpeedViolations++;
      if (abs(d.bankAngle ?? 0) > MAX_BANK_NORMAL_DEG) this._descentBankViolations++;
      if (abs(d.pitch ?? 0)     > MAX_PITCH_DESCENT_DEG) this._descentPitchViolations++;
      if ((d.gForce ?? 0) > this._descentMaxGForce) this._descentMaxGForce = d.gForce;
    }

    // ── Approach scoring ────────────────────────────────────────────────────
    if (phase === PHASE.APPROACH) {
      const agl = d.altAgl ?? 9999;

      // Accumulate GS deviation and speed samples
      this._approachGsSamples.push(d.gsDeviation ?? 0);
      if (agl < 2000) this._approachSpeedSamples.push(d.ias);

      // Gate check at 1000 AGL (one-time)
      if (!this._checkedAt1000 && agl <= GEAR_DOWN_AGL_FT) {
        this._checkedAt1000  = true;
        this._gearDownBy1000 = d.gearDown === true;
        this._flapsSetBy1000 = (d.flapsIndex ?? 0) > 1;
      }

      // Gate check at 500 AGL (one-time) — stabilised approach criteria
      if (!this._checkedAt500 && agl <= STABILISED_AGL_FT) {
        this._checkedAt500 = true;
        const vsOk    = (d.vs ?? 0) > MAX_APPROACH_VS_FPM;      // > -1000 fpm
        const bankOk  = abs(d.bankAngle ?? 0) <= MAX_BANK_APPROACH_DEG;
        const pitchOk = abs(d.pitch ?? 0)     <= MAX_PITCH_APPROACH_DEG;
        const gearOk  = d.gearDown === true;
        this._stabilisedBelow500 = vsOk && bankOk && pitchOk && gearOk;
      }
    }

    // ── Taxi in (POST_FLIGHT) ───────────────────────────────────────────────
    if (phase === PHASE.POST_FLIGHT) {
      if (d.groundSpeed > this._taxiInMaxSpeed) this._taxiInMaxSpeed = d.groundSpeed;
      this._taxiInFrameCount++;
      if (d.lightTaxi) this._taxiInLightOnFrames++;
      if (!d.lightLanding) this._taxiInLandingLightsOff = true;
      if (!d.lightStrobe)  this._taxiInStrobesOff       = true;
      this._checkTurnSpeed(d, 'in');
    }
  }

  /**
   * Detect speed-on-turn violations.
   * Accumulates heading delta; when > TURN_HEADING_DELTA_DEG, checks GS.
   * @param {'out'|'in'} leg
   */
  _checkTurnSpeed(d, leg) {
    if (this._prevHeading == null) return;
    const delta = Math.abs(headingDelta(this._prevHeading, d.heading ?? this._prevHeading));
    this._turnHeadingAcc += delta;

    if (this._turnHeadingAcc >= TURN_HEADING_DELTA_DEG) {
      if (d.groundSpeed > MAX_TURN_SPEED_KT) {
        if (leg === 'out') this._taxiOutTurnViolations++;
        else               this._taxiInTurnViolations++;
      }
      this._turnHeadingAcc = 0;
    }
  }

  // ── State machine ─────────────────────────────────────────────────────────

  _runStateMachine(d) {
    const enginesOn = d.eng1 || d.eng2;

    switch (this._phase) {

      case PHASE.IDLE:
        break;

      case PHASE.PRE_FLIGHT:
        if (enginesOn && d.onGround) {
          this._blockOutTime      = Date.now();
          this._fuelAtStart       = d.fuelGallons;
          this._beaconOnBeforeTaxi = d.lightBeacon === true; // must be on before rolling
          this._resetFlightRecord(/* keepBlockOut= */ true);
          this._departureIcao = this._airports.nearest(d.lat, d.lon);
          this._setPhase(PHASE.TAXI);
        }
        break;

      case PHASE.TAXI:
        if (!enginesOn) {
          this._setPhase(PHASE.PRE_FLIGHT);
        } else if (d.groundSpeed > TAKEOFF_IAS_KT && d.onGround) {
          // Snapshot taxi-out results before leaving the phase
          this._taxiOutLightFraction  = this._taxiFrameCount > 0
            ? this._taxiLightOnFrames / this._taxiFrameCount : 1.0;
          this._landingLightsAtTakeoff = d.lightLanding === true;
          // Reset shared turn/frame counters for taxi-in use later
          this._turnHeadingAcc    = 0;
          this._taxiFrameCount    = 0;
          this._taxiLightOnFrames = 0;
          this._setPhase(PHASE.TAKEOFF_ROLL);
        }
        break;

      case PHASE.TAKEOFF_ROLL:
        if (!d.onGround) {
          this._rotateSpeed  = d.ias;
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
          // Finalise cruise mach RMS before leaving
          this._cruiseMachRms = rms(this._cruiseMachSamples);
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
          // Go-around — reset approach state
          this._thresholdCrossedPos = null;
          this._checkedAt1000 = false;
          this._checkedAt500  = false;
          this._approachGsSamples   = [];
          this._approachSpeedSamples = [];
          this._setPhase(PHASE.CLIMB);
        }
        break;

      case PHASE.LANDING:
        if (d.groundSpeed < LANDING_GS_KT) {
          // Reset turn accumulator so taxi-in detection starts clean
          this._turnHeadingAcc    = 0;
          this._taxiInFrameCount  = 0;
          this._taxiInLightOnFrames = 0;
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

  // ── Touchdown ────────────────────────────────────────────────────────────────

  _handleTouchdown(d) {
    this._touchdownVs     = d.vs;
    this._wheelsDownTime  = Date.now();
    this._arrivalIcao     = this._airports.nearest(d.lat, d.lon);
    this._fuelAtEnd       = d.fuelGallons;
    this._touchdownPos    = { lat: d.lat, lon: d.lon };
    this._touchdownPitch  = d.pitch  ?? 0;
    this._touchdownGForce = d.gForce ?? 0;

    // Tail strike at touchdown
    if ((d.pitch ?? 0) > TAIL_STRIKE_PITCH_DEG && !this._tailStrike) {
      this._tailStrike          = true;
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

  // ── Flight complete ──────────────────────────────────────────────────────────

  _completeFlight(d) {
    if (!this._wheelsUpTime) return;

    const now         = Date.now();
    const wheelsDown  = this._wheelsDownTime ?? now;
    const airTimeMs   = wheelsDown - this._wheelsUpTime;
    const airTimeMin  = Math.round(airTimeMs / 60000);

    const blockOut      = this._blockOutTime ?? (this._wheelsUpTime - 15 * 60000);
    const blockIn       = this._blockInTime  ?? (wheelsDown + 10 * 60000);
    const groundTimeMs  = (this._wheelsUpTime - blockOut) + (blockIn - wheelsDown);
    const groundTimeMin = Math.max(0, Math.round(groundTimeMs / 60000));

    const fuelUsed = (this._fuelAtStart !== null && this._fuelAtEnd !== null)
      ? Math.round((this._fuelAtStart - this._fuelAtEnd) * 10) / 10
      : null;

    const speeds = getAircraftSpeeds(this._aircraftTypeCode);

    // Taxi-in light fraction
    this._taxiInLightFraction = this._taxiInFrameCount > 0
      ? this._taxiInLightOnFrames / this._taxiInFrameCount : 1.0;

    // Strobe compliance fraction (1.0 = always on)
    const strobeCompliance = this._strobeTrackedFrames > 0
      ? 1 - (this._strobeOffFrames / this._strobeTrackedFrames) : 1.0;

    // Average approach speed
    const avgApproachSpeed = this._approachSpeedSamples.length
      ? Math.round(this._approachSpeedSamples.reduce((s, v) => s + v, 0) / this._approachSpeedSamples.length)
      : null;

    const record = {
      sessionDate:      new Date().toISOString().split('T')[0],
      aircraft:         this._detectAircraftType(),
      departure:        this._departureIcao,
      arrival:          this._arrivalIcao,
      resumedMidFlight: this._resumedMidFlight,
      duration:         airTimeMin,
      airTime:          airTimeMin / 60,
      groundTime:       groundTimeMin / 60,
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

      // ── Phase scoring sub-objects ──────────────────────────────────────────
      preFlight: {
        beaconOnBeforeTaxi: this._beaconOnBeforeTaxi,
      },

      taxiOut: {
        maxSpeed:       Math.round(this._taxiOutMaxSpeed * 10) / 10,
        turnViolations: this._taxiOutTurnViolations,
        lightFraction:  Math.round(this._taxiOutLightFraction * 1000) / 1000,
      },

      takeoff: {
        rotateSpeed:         this._rotateSpeed,
        vr:                  speeds.vr,
        landingLightsOn:     this._landingLightsAtTakeoff,
        bankViolations:      this._takeoffBankViolations,
        pitchViolations:     this._takeoffPitchViolations,
      },

      climb: {
        speedViolationsBelow10k: this._climbSpeedViolations,
        bankViolations:          this._climbBankViolations,
        maxGForce:               Math.round(this._climbMaxGForce * 100) / 100,
        strobeCompliance,
        landingLightsViolation:  this._landingLightsViolation,
      },

      cruise: {
        altViolations:    this._cruiseAltViolations,
        machRms:          Math.round(this._cruiseMachRms * 10000) / 10000,
        bankViolations:   this._cruiseBankViolations,
        maxGForce:        Math.round(this._cruiseMaxGForce * 100) / 100,
      },

      descent: {
        speedViolationsBelow10k: this._descentSpeedViolations,
        bankViolations:          this._descentBankViolations,
        pitchViolations:         this._descentPitchViolations,
        maxGForce:               Math.round(this._descentMaxGForce * 100) / 100,
      },

      approach: {
        gearDownBy1000:    this._gearDownBy1000,
        flapsSetBy1000:    this._flapsSetBy1000,
        stabilisedBelow500: this._stabilisedBelow500,
        gsDeviationRms:    Math.round(rms(this._approachGsSamples) * 1000) / 1000,
        vapp:              speeds.vapp,
        avgApproachSpeed,
      },

      taxiIn: {
        maxSpeed:           Math.round(this._taxiInMaxSpeed * 10) / 10,
        turnViolations:     this._taxiInTurnViolations,
        lightFraction:      Math.round(this._taxiInLightFraction * 1000) / 1000,
        landingLightsOff:   this._taxiInLandingLightsOff,
        strobesOff:         this._taxiInStrobesOff,
      },
    };

    this.emit('flightComplete', record);
    this._resetFlightRecord();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _detectAircraftType() {
    return this._aircraftTypeCode ?? 'UNKN';
  }

  _setPhase(phase) {
    if (this._phase === phase) return;
    const prev = this._phase;
    this._phase = phase;
    this.emit('phase', { phase, prev });

    // Record cruise entry timestamp for the 60s lock timer
    if (phase === PHASE.CRUISE) {
      this._cruiseEnteredAt = Date.now();
    }

    // High-frequency polling near landing
    if (phase === PHASE.APPROACH) {
      this.emit('highFreq', { enabled: true });
    } else if (phase === PHASE.POST_FLIGHT || phase === PHASE.TAXI) {
      this.emit('highFreq', { enabled: false });
    }
  }

  _resetFlightRecord(keepBlockOut = false) {
    const savedBlockOut  = keepBlockOut ? this._blockOutTime      : null;
    const savedBeacon    = keepBlockOut ? this._beaconOnBeforeTaxi : false;

    // Core
    this._resumedMidFlight    = false;
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
    this._blockInTime         = null;
    this._thresholdCrossedPos = null;
    this._touchdownPos        = null;
    this._touchdownZoneHit    = false;
    this._touchdownPitch      = 0;
    this._touchdownGForce     = 0;
    this._bounces             = [];
    this._lastLiftoffTime     = null;
    this._tailStrike          = false;
    this._tailStrikeTimestamp = null;

    // Scoring
    this._beaconOnBeforeTaxi      = false;
    this._prevHeading             = null;
    this._turnHeadingAcc          = 0;
    this._taxiFrameCount          = 0;
    this._taxiLightOnFrames       = 0;
    this._taxiOutMaxSpeed         = 0;
    this._taxiOutTurnViolations   = 0;
    this._taxiOutLightFraction    = 1.0;
    this._rotateSpeed             = null;
    this._landingLightsAtTakeoff  = false;
    this._takeoffBankViolations   = 0;
    this._takeoffPitchViolations  = 0;
    this._strobeOffFrames         = 0;
    this._strobeTrackedFrames     = 0;
    this._landingLightsViolation  = false;
    this._climbSpeedViolations    = 0;
    this._climbBankViolations     = 0;
    this._climbMaxGForce          = 0;
    this._cruiseEnteredAt         = null;
    this._cruiseAltTarget         = null;
    this._cruiseMachLock          = null;
    this._cruiseMachSamples       = [];
    this._cruiseAltViolations     = 0;
    this._cruiseBankViolations    = 0;
    this._cruiseMaxGForce         = 0;
    this._cruiseMachRms           = 0;
    this._descentSpeedViolations  = 0;
    this._descentBankViolations   = 0;
    this._descentPitchViolations  = 0;
    this._descentMaxGForce        = 0;
    this._approachGsSamples       = [];
    this._approachSpeedSamples    = [];
    this._gearDownBy1000          = false;
    this._flapsSetBy1000          = false;
    this._stabilisedBelow500      = false;
    this._checkedAt1000           = false;
    this._checkedAt500            = false;
    this._taxiInMaxSpeed          = 0;
    this._taxiInTurnViolations    = 0;
    this._taxiInLightFraction     = 1.0;
    this._taxiInLandingLightsOff  = false;
    this._taxiInStrobesOff        = false;
    this._taxiInFrameCount        = 0;
    this._taxiInLightOnFrames     = 0;

    this._blockOutTime      = savedBlockOut;
    this._beaconOnBeforeTaxi = savedBeacon;
  }
}

module.exports = FlightTracker;
