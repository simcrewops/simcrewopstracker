'use strict';

/**
 * FlightTracker v2 — V5 scoring integration
 *
 * State machine that consumes SimConnect frames and emits high-level flight events.
 * Designed to run alongside MSFS without causing memory leaks or performance issues.
 *
 * Phases:
 *   IDLE → PREFLIGHT → TAXI_OUT → TAKEOFF_ROLL → AIRBORNE → CLIMB → CRUISE
 *        → DESCENT → APPROACH → STABILIZED_APPROACH → LANDING → TAXI_IN
 *        → POST_FLIGHT → PREFLIGHT (next flight)
 *
 * Memory management:
 *   - Tick data (5s interval) stored in a plain array capped at MAX_TICKS_MEMORY.
 *     When full, oldest ARCHIVE_CHUNK ticks are flushed to a temp file on disk.
 *   - High-frequency landing buffer (100ms ticks): max 600 entries (~60s) in memory.
 *   - Route points: capped at 2160 (6h at 10s interval).
 *   - Resource monitor runs every 60s; triggers cleanup if process.rss > 200MB.
 *   - All timers and listeners are cleared on stop/disconnect.
 *
 * Events emitted:
 *   phase        { phase, prev }
 *   takeoff      { airport, ias, time }
 *   landing      { airport, landingRate, gForce, bank, pitch, touchdownZoneHit, bounceCount, time }
 *   highFreq     { enabled }            — tells main.js to toggle SimConnect HF mode
 *   flightComplete { ...record, ticks } — full record + all tick data for V5 scoring
 */

const { EventEmitter } = require('events');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Airports = require('./airports');

// ── Phase constants ────────────────────────────────────────────────────────────
const PHASE = {
  IDLE:                 'idle',
  PREFLIGHT:            'preflight',
  TAXI_OUT:             'taxi_out',
  TAKEOFF_ROLL:         'takeoff_roll',
  AIRBORNE:             'airborne',
  CLIMB:                'climb',
  CRUISE:               'cruise',
  DESCENT:              'descent',
  APPROACH:             'approach',
  STABILIZED_APPROACH:  'stabilized_approach',
  LANDING:              'landing',
  TAXI_IN:              'taxi_in',
  POST_FLIGHT:          'post_flight',
};

// ── Thresholds ─────────────────────────────────────────────────────────────────
const TAKEOFF_IAS_KT       = 60;
const LANDING_GS_KT        = 10;
const CRUISE_ALT_FT        = 10000;
const APPROACH_ALT_FT      = 5000;
const STABILIZED_AGL_FT    = 500;    // below this AGL = stabilized approach
const VS_CLIMB_FPM         = 200;
const VS_DESCENT_FPM       = -200;
const VS_LEVEL_FPM         = 200;    // |VS| < this = level flight
const ENGINES_OFF_TIMEOUT  = 30000;  // ms engines off before POST_FLIGHT → complete

// Touchdown zone detection
const THRESHOLD_AGL_FT     = 80;     // record threshold crossing when AGL drops below this
const TOUCHDOWN_ZONE_FT    = 1500;   // max distance from threshold to count as in-zone

// Heavy aircraft: ≥ 4 engines → 300kt speed limit below FL100 (vs 250kt)
const HEAVY_ENGINE_COUNT   = 4;

// Cruise altitude auto-detection
const CRUISE_LEVEL_TIME_MS = 60000;  // 60s at level flight = accept as cruise altitude

// Bounce detection
const BOUNCE_MIN_AIRTIME_MS = 500;   // must be airborne 500ms+ to count as a bounce

// ── Memory management ──────────────────────────────────────────────────────────
const TICK_INTERVAL_MS       = 5000;   // save one FlightTick every 5s
const MAX_TICKS_MEMORY       = 1080;   // ~90 min at 5s; archive overflow to disk
const ARCHIVE_CHUNK          = 540;    // archive 540 ticks at a time (~45 min chunk)
const MAX_HF_TICKS           = 600;    // max high-freq landing ticks in memory (~60s)
const ROUTE_INTERVAL_MS      = 10000;  // route point every 10s
const MAX_ROUTE_POINTS       = 2160;   // cap ~6h
const MEMORY_CHECK_MS        = 60000;  // check RSS every 60s
const MEMORY_THRESHOLD_BYTES = 200 * 1024 * 1024;  // 200MB RSS trigger

// ── Haversine distance ─────────────────────────────────────────────────────────
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

// ── Simple landing-rate grade ─────────────────────────────────────────────────
function landingRateGrade(fpm) {
  const abs = Math.abs(fpm);
  if (abs < 100) return 'A+';
  if (abs < 200) return 'A';
  if (abs < 400) return 'B';
  if (abs < 600) return 'C';
  if (abs < 800) return 'D';
  return 'F';
}

class FlightTracker extends EventEmitter {
  constructor() {
    super();

    this._active       = false;
    this._phase        = PHASE.IDLE;
    this._lastData     = null;
    this._prevOnGround = true;
    this._enginesOffAt = null;

    // Aircraft / session metadata
    this._isHeavy        = false;  // ≥4 engines → heavy speed limits
    this._engineCount    = 2;
    this._departureIcao  = null;
    this._arrivalIcao    = null;
    this._fuelAtStart    = null;
    this._fuelAtEnd      = null;

    // Peak/aggregate metrics
    this._maxAlt     = 0;
    this._maxGForce  = 0;

    // Time tracking
    this._blockOutTime   = null;
    this._wheelsUpTime   = null;
    this._wheelsDownTime = null;
    this._blockInTime    = null;

    // Touchdown zone detection
    this._thresholdCrossedPos = null;  // { lat, lon } when AGL < THRESHOLD_AGL_FT
    this._touchdownPos        = null;
    this._touchdownZoneHit    = false;
    this._touchdownVs         = 0;
    this._touchdownGForce     = 0;
    this._touchdownBank       = 0;
    this._touchdownPitch      = 0;

    // Bounce detection
    this._bounceCount       = 0;
    this._bounceAirborneAt  = null;
    this._prevLfOnGround    = true;

    // Cruise altitude auto-detection
    this._cruiseAlt     = null;
    this._levelStartAt  = null;

    // Route points (for map)
    this._routePoints  = [];
    this._lastRouteAt  = 0;

    // Tick data for V5 scoring
    this._ticks        = [];     // in-memory buffer (up to MAX_TICKS_MEMORY)
    this._lastTickAt   = 0;
    this._archivePath  = null;   // temp file path for disk overflow
    this._archiveBytes = 0;      // bytes written to archive (for size tracking)

    // High-frequency landing buffer
    this._hfBuf        = [];     // landing tick buffer
    this._hfActive     = false;

    // Memory monitor
    this._memMonitor   = null;

    this._airports = new Airports();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  isTracking() { return this._active; }

  /** Called by main.js after SimConnect connects, so we know engine count. */
  setEngineCount(n) {
    this._engineCount = n || 2;
    this._isHeavy = n >= HEAVY_ENGINE_COUNT;
    if (this._isHeavy) console.log(`[Tracker] Heavy aircraft detected (${n} engines)`);
  }

  start() {
    this._active = true;
    this._startMemoryMonitor();
    if (this._phase === PHASE.IDLE) this._setPhase(PHASE.PREFLIGHT);
  }

  stop() {
    this._active = false;
    this._stopMemoryMonitor();
    this._stopHighFreq();
    this._setPhase(PHASE.IDLE);
    this._resetFlightRecord();
  }

  // Aliases kept for backward compat with main.js
  startTracking() { this.start(); }
  stopTracking()  { this.stop();  }

  /**
   * Called every time the SimConnect 1Hz data arrives.
   * Keep this method fast — it runs in the main process hot path.
   */
  update(d) {
    if (!this._active) return;
    this._lastData = d;

    const now = Date.now();

    // Track peaks
    if (d.altitude > this._maxAlt)   this._maxAlt   = d.altitude;
    if (d.gForce   > this._maxGForce) this._maxGForce = d.gForce;
    if (this._fuelAtStart === null)   this._fuelAtStart = d.fuelGallons;

    // Route point
    if (now - this._lastRouteAt > ROUTE_INTERVAL_MS) {
      this._routePoints.push({ lat: d.lat, lon: d.lon, alt: d.altitude, ts: now });
      this._lastRouteAt = now;
      if (this._routePoints.length > MAX_ROUTE_POINTS) this._routePoints.shift();
    }

    // Cruise altitude auto-detection
    this._trackCruiseAlt(d, now);

    // Threshold crossing for touchdown zone
    if ((this._phase === PHASE.APPROACH || this._phase === PHASE.STABILIZED_APPROACH) && !d.onGround) {
      const agl = d.altAgl ?? 999;
      if (agl < THRESHOLD_AGL_FT && !this._thresholdCrossedPos) {
        this._thresholdCrossedPos = { lat: d.lat, lon: d.lon };
      }
    }

    // Tick data (5s interval during active flight)
    if (this._wheelsUpTime && now - this._lastTickAt > TICK_INTERVAL_MS) {
      this._recordTick(d, now);
    }

    // High-freq mode: activate below 500 AGL on approach
    this._manageHighFreqMode(d);

    this._runStateMachine(d);
    this._prevOnGround = d.onGround;
  }

  /**
   * Called with high-frequency landing data (100ms ticks) from SimConnect.
   * Only active during approach/landing.
   */
  processLandingTick(lfd) {
    if (!this._hfActive) return;

    // Bounce detection
    if (this._prevLfOnGround !== lfd.onGround) {
      if (!lfd.onGround) {
        // Lifted off — potential bounce start
        this._bounceAirborneAt = lfd.ts;
      } else if (this._bounceAirborneAt && (lfd.ts - this._bounceAirborneAt) >= BOUNCE_MIN_AIRTIME_MS) {
        // Touched down after being airborne for 500ms+ = counted bounce
        this._bounceCount++;
        console.log(`[Tracker] Bounce detected (count: ${this._bounceCount})`);
      }
      this._prevLfOnGround = lfd.onGround;
    }

    // Capture exact touchdown moment (first onGround transition)
    if (lfd.onGround && !this._prevLfOnGround && !this._wheelsDownTime) {
      this._wheelsDownTime  = lfd.ts;
      this._touchdownVs     = lfd.vs;
      this._touchdownGForce = lfd.gForce;
      this._touchdownBank   = Math.abs(lfd.bank);
      this._touchdownPitch  = lfd.pitch;
    }

    // Store in HF buffer (capped)
    if (this._hfBuf.length < MAX_HF_TICKS) {
      this._hfBuf.push(lfd);
    }
  }

  /** Force-trigger disk cleanup of non-essential cached data. */
  triggerMemoryCleanup() {
    console.log('[Tracker] Memory cleanup triggered');
    // Trim HF buffer to most recent 60 entries
    if (this._hfBuf.length > 60) {
      this._hfBuf.splice(0, this._hfBuf.length - 60);
    }
  }

  // ── State machine ─────────────────────────────────────────────────────────────
  _runStateMachine(d) {
    const enginesOn = d.eng1 || d.eng2 || d.eng3 || d.eng4;

    switch (this._phase) {
      case PHASE.IDLE:
        break;

      case PHASE.PREFLIGHT:
        if (enginesOn && d.onGround) {
          this._blockOutTime   = Date.now();
          this._departureIcao  = this._airports.nearest(d.lat, d.lon);
          this._fuelAtStart    = d.fuelGallons;
          this._resetFlightRecord(true);
          this._setPhase(PHASE.TAXI_OUT);
        }
        break;

      case PHASE.TAXI_OUT:
        if (!enginesOn) {
          this._setPhase(PHASE.PREFLIGHT);
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
          this._setPhase(PHASE.TAXI_OUT);
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
        } else if ((d.altAgl ?? 999) < STABILIZED_AGL_FT && d.gearDown) {
          this._setPhase(PHASE.STABILIZED_APPROACH);
        } else if (d.vs > VS_CLIMB_FPM) {
          // Go-around
          this._thresholdCrossedPos = null;
          this._setPhase(PHASE.CLIMB);
        }
        break;

      case PHASE.STABILIZED_APPROACH:
        if (d.onGround && !this._prevOnGround) {
          this._handleTouchdown(d);
        } else if ((d.altAgl ?? 0) > STABILIZED_AGL_FT) {
          // Went back above 500 AGL — go-around
          this._thresholdCrossedPos = null;
          this._setPhase(PHASE.APPROACH);
        } else if (d.vs > VS_CLIMB_FPM) {
          // Positive VS while low — go-around
          this._thresholdCrossedPos = null;
          this._setPhase(PHASE.CLIMB);
        }
        break;

      case PHASE.LANDING:
        if (d.groundSpeed < LANDING_GS_KT) {
          this._stopHighFreq();
          this._setPhase(PHASE.TAXI_IN);
        }
        break;

      case PHASE.TAXI_IN:
        if (!enginesOn) {
          if (!this._enginesOffAt) {
            this._enginesOffAt = Date.now();
          } else if (Date.now() - this._enginesOffAt > ENGINES_OFF_TIMEOUT) {
            this._blockInTime  = Date.now();
            this._completeFlight(d);
            this._setPhase(PHASE.PREFLIGHT);
            this._enginesOffAt = null;
          }
        } else {
          this._enginesOffAt = null;
        }
        break;

      // POST_FLIGHT kept for backward compatibility (may be set externally)
      case PHASE.POST_FLIGHT:
        if (!enginesOn) {
          if (!this._enginesOffAt) {
            this._enginesOffAt = Date.now();
          } else if (Date.now() - this._enginesOffAt > ENGINES_OFF_TIMEOUT) {
            this._blockInTime = Date.now();
            this._completeFlight(d);
            this._setPhase(PHASE.PREFLIGHT);
            this._enginesOffAt = null;
          }
        } else {
          this._enginesOffAt = null;
        }
        break;
    }
  }

  // ── Landing / touchdown ───────────────────────────────────────────────────────
  _handleTouchdown(d) {
    const now = Date.now();

    // If we already got the exact touchdown time from processLandingTick, don't overwrite.
    if (!this._wheelsDownTime) {
      this._wheelsDownTime  = now;
      this._touchdownVs     = d.vs;
      this._touchdownGForce = d.gForce;
      this._touchdownBank   = Math.abs(d.bank ?? 0);
      this._touchdownPitch  = d.pitch ?? 0;
    }

    this._arrivalIcao = this._airports.nearest(d.lat, d.lon);
    this._fuelAtEnd   = d.fuelGallons;
    this._touchdownPos = { lat: d.lat, lon: d.lon };

    // Touchdown zone detection
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
      landingRate:      Math.round(this._touchdownVs),
      gForce:           this._touchdownGForce,
      bank:             this._touchdownBank,
      pitch:            this._touchdownPitch,
      touchdownZoneHit: this._touchdownZoneHit,
      bounceCount:      this._bounceCount,
      time:             this._wheelsDownTime,
    });
  }

  // ── Flight completion ─────────────────────────────────────────────────────────
  _completeFlight(d) {
    if (!this._wheelsUpTime) return;  // No takeoff recorded — ignore

    const now       = Date.now();
    const wheelsDown = this._wheelsDownTime ?? now;
    const blockOut   = this._blockOutTime   ?? (this._wheelsUpTime - 15 * 60000);
    const blockIn    = this._blockInTime    ?? (wheelsDown + 10 * 60000);

    const airTimeMs   = wheelsDown - this._wheelsUpTime;
    const airTimeHrs  = Math.max(0, airTimeMs / 3600000);
    const airTimeMin  = Math.round(airTimeHrs * 60);

    const groundTimeMs  = (this._wheelsUpTime - blockOut) + (blockIn - wheelsDown);
    const groundTimeHrs = Math.max(0, groundTimeMs / 3600000);

    const fuelUsed = (this._fuelAtStart !== null && this._fuelAtEnd !== null)
      ? Math.round((this._fuelAtStart - this._fuelAtEnd) * 10) / 10
      : null;

    const lr    = Math.round(this._touchdownVs);
    const grade = landingRateGrade(lr);

    // Collect all ticks (disk archive + memory)
    const allTicks = this._collectAllTicks();

    const record = {
      sessionDate:      new Date().toISOString().split('T')[0],
      aircraft:         this._detectAircraftType(),
      isHeavy:          this._isHeavy,
      engineCount:      this._engineCount,
      departure:        this._departureIcao,
      arrival:          this._arrivalIcao,
      duration:         airTimeMin,
      airTime:          Math.round(airTimeHrs * 100) / 100,
      groundTime:       Math.round(groundTimeHrs * 100) / 100,
      landingRate:      lr,
      grade,
      touchdownZoneHit: this._touchdownZoneHit,
      bounceCount:      this._bounceCount,
      touchdownGForce:  this._touchdownGForce,
      touchdownBank:    this._touchdownBank,
      touchdownPitch:   this._touchdownPitch,
      maxAltitude:      this._maxAlt,
      maxGForce:        Math.round(this._maxGForce * 100) / 100,
      fuelUsed,
      cruiseAlt:        this._cruiseAlt,
      routePoints:      this._routePoints,
      landingTicks:     this._hfBuf,   // high-freq landing data
      ticks:            allTicks,      // full flight ticks for V5 scoring
      simVersion:       'MSFS 2020/2024',
      source:           'simconnect',
    };

    this.emit('flightComplete', record);
    this._cleanupArchive();
    this._resetFlightRecord();
  }

  // ── Tick data management ──────────────────────────────────────────────────────
  _recordTick(d, now) {
    this._lastTickAt = now;

    const tick = {
      ts:          now,
      phase:       this._phase,
      lat:         d.lat,
      lon:         d.lon,
      alt:         d.altitude,
      altAgl:      d.altAgl,
      ias:         d.ias,
      tas:         d.tas,
      mach:        d.mach,
      gs:          d.groundSpeed,
      vs:          d.vs,
      pitch:       d.pitch,
      bank:        Math.abs(d.bank ?? 0),
      gForce:      d.gForce,
      onGround:    d.onGround,
      gearDown:    d.gearDown,
      flapsIndex:  d.flapsIndex,
      parkingBrake:d.parkingBrake,
      fuelGal:     d.fuelGallons,
      engRunning:  [d.eng1, d.eng2, d.eng3, d.eng4].filter(Boolean).length,
      lights: {
        beacon:  d.lightBeacon,
        nav:     d.lightNav,
        strobe:  d.lightStrobe,
        landing: d.lightLanding,
      },
      navLocDev:   d.navLocDev,
      navGsDev:    d.navGsDev,
    };

    this._ticks.push(tick);

    // Archive overflow to disk when buffer fills
    if (this._ticks.length > MAX_TICKS_MEMORY) {
      this._archiveTicks(this._ticks.splice(0, ARCHIVE_CHUNK));
    }
  }

  _archiveTicks(ticks) {
    if (!ticks.length) return;
    try {
      if (!this._archivePath) {
        this._archivePath = path.join(os.tmpdir(), `sco-flight-${Date.now()}.jsonl`);
        console.log(`[Tracker] Archiving ticks to ${this._archivePath}`);
      }
      const lines = ticks.map(t => JSON.stringify(t)).join('\n') + '\n';
      fs.appendFileSync(this._archivePath, lines, 'utf8');
      this._archiveBytes += Buffer.byteLength(lines);
      console.log(`[Tracker] Archived ${ticks.length} ticks (total: ${Math.round(this._archiveBytes / 1024)} KB on disk)`);
    } catch (err) {
      console.error('[Tracker] Failed to archive ticks:', err.message);
    }
  }

  _collectAllTicks() {
    let diskTicks = [];
    if (this._archivePath) {
      try {
        const raw = fs.readFileSync(this._archivePath, 'utf8');
        diskTicks = raw
          .split('\n')
          .filter(Boolean)
          .map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean);
      } catch (err) {
        console.error('[Tracker] Failed to read tick archive:', err.message);
      }
    }
    return [...diskTicks, ...this._ticks];
  }

  _cleanupArchive() {
    if (this._archivePath) {
      try { fs.unlinkSync(this._archivePath); } catch {}
      this._archivePath  = null;
      this._archiveBytes = 0;
    }
  }

  // ── High-frequency mode ───────────────────────────────────────────────────────
  _manageHighFreqMode(d) {
    const agl = d.altAgl ?? 9999;
    const shouldBeHf = !d.onGround && agl < STABILIZED_AGL_FT &&
      (this._phase === PHASE.APPROACH ||
       this._phase === PHASE.STABILIZED_APPROACH ||
       this._phase === PHASE.LANDING);

    if (shouldBeHf && !this._hfActive) {
      this._hfActive = true;
      this.emit('highFreq', { enabled: true });
    } else if (!shouldBeHf && this._hfActive && d.onGround) {
      // Keep HF active until speed drops — managed by _stopHighFreq after landing
    }
  }

  _stopHighFreq() {
    if (this._hfActive) {
      this._hfActive = false;
      this.emit('highFreq', { enabled: false });
    }
  }

  // ── Cruise altitude tracking ──────────────────────────────────────────────────
  _trackCruiseAlt(d, now) {
    if (this._phase !== PHASE.CRUISE && this._phase !== PHASE.CLIMB && this._phase !== PHASE.DESCENT) {
      this._levelStartAt = null;
      return;
    }
    if (Math.abs(d.vs) < VS_LEVEL_FPM) {
      if (!this._levelStartAt) this._levelStartAt = now;
      else if (now - this._levelStartAt >= CRUISE_LEVEL_TIME_MS) {
        if (this._cruiseAlt !== d.altitude) {
          this._cruiseAlt    = d.altitude;
          this._levelStartAt = now;  // Reset so next level-off at new alt is accepted
          console.log(`[Tracker] Cruise altitude updated: ${d.altitude} ft`);
        }
      }
    } else {
      this._levelStartAt = null;
    }
  }

  // ── Memory monitor ────────────────────────────────────────────────────────────
  _startMemoryMonitor() {
    this._memMonitor = setInterval(() => {
      const rss = process.memoryUsage().rss;
      const mb  = Math.round(rss / 1024 / 1024);
      console.log(`[Tracker/Memory] RSS: ${mb}MB, ticks: ${this._ticks.length}, route: ${this._routePoints.length}`);
      if (rss > MEMORY_THRESHOLD_BYTES) {
        console.warn(`[Tracker/Memory] ${mb}MB exceeds threshold — triggering cleanup`);
        this.triggerMemoryCleanup();
      }
    }, MEMORY_CHECK_MS);
  }

  _stopMemoryMonitor() {
    if (this._memMonitor) {
      clearInterval(this._memMonitor);
      this._memMonitor = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  _detectAircraftType() {
    // Future: read from SimConnect TITLE simvar; for now return placeholder
    return 'UNKN';
  }

  _resetFlightRecord(keepBlockOut = false) {
    const savedBlockOut = keepBlockOut ? this._blockOutTime : null;

    this._maxAlt             = 0;
    this._maxGForce          = 0;
    this._fuelAtStart        = null;
    this._fuelAtEnd          = null;
    this._departureIcao      = null;
    this._arrivalIcao        = null;
    this._touchdownVs        = 0;
    this._touchdownGForce    = 0;
    this._touchdownBank      = 0;
    this._touchdownPitch     = 0;
    this._wheelsUpTime       = null;
    this._wheelsDownTime     = null;
    this._blockInTime        = null;
    this._thresholdCrossedPos = null;
    this._touchdownPos       = null;
    this._touchdownZoneHit   = false;
    this._bounceCount        = 0;
    this._bounceAirborneAt   = null;
    this._prevLfOnGround     = true;
    this._cruiseAlt          = null;
    this._levelStartAt       = null;
    this._routePoints        = [];
    this._lastRouteAt        = 0;
    this._ticks              = [];
    this._lastTickAt         = 0;
    this._hfBuf              = [];
    this._hfActive           = false;
    this._enginesOffAt       = null;

    // Clean up any leftover archive from a previous incomplete flight
    this._cleanupArchive();

    this._blockOutTime = savedBlockOut;
  }

  _setPhase(phase) {
    if (this._phase === phase) return;
    const prev = this._phase;
    this._phase = phase;
    console.log(`[Tracker] Phase: ${prev} → ${phase}`);
    this.emit('phase', { phase, prev });
  }

  getCurrentPhase() { return this._phase; }

  /** Estimated live grade based on current landing rate (for UI preview). */
  getLiveGrade() {
    if (!this._touchdownVs && this._phase !== PHASE.LANDING) return null;
    return landingRateGrade(this._touchdownVs || this._lastData?.vs || 0);
  }
}

module.exports = FlightTracker;
