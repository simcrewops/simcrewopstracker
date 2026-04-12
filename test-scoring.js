'use strict';
/**
 * Scoring accumulator tests for FlightTracker.
 * Each test creates a fresh FlightTracker to avoid state leakage.
 * Run: node test-scoring.js
 */

const FlightTracker = require('./src/flight-tracker');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, cond, got, expected) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label} — got ${JSON.stringify(got)} expected ${expected}`);
    failed++;
  }
}

/** Build a base SimConnect data frame with all required fields. */
function frame(overrides = {}) {
  return {
    lat: 51.5, lon: -0.12,
    altitude: 35000, altAgl: 35000,
    ias: 480, groundSpeed: 480, vs: 0, mach: 0.78,
    heading: 90,
    bankAngle: 0, pitch: 2,
    gForce: 1.0,
    onGround: false,
    eng1: true, eng2: true,
    fuelGallons: 10000,
    gearDown: false, flapsIndex: 0,
    lightBeacon: true, lightNav: true, lightStrobe: true,
    lightLanding: false, lightTaxi: false,
    gsDeviation: 0,
    ...overrides,
  };
}

/**
 * Drive a fresh tracker through a standard flight up to the requested exit phase.
 * Returns the tracker.
 * Phases driven: PRE_FLIGHT → TAXI → TAKEOFF_ROLL → AIRBORNE → CLIMB → CRUISE → DESCENT → ...
 */
function buildTracker(options = {}) {
  const t = new FlightTracker();
  t.start(); // → PRE_FLIGHT
  return t;
}

/**
 * Feed enough frames to reach CRUISE phase and return the tracker.
 * Leaves tracker in CRUISE with _cruiseEnteredAt just set.
 */
function trackerInCruise(options = {}) {
  const t = new FlightTracker();
  t.start();

  // PRE_FLIGHT → TAXI (engines on, onGround)
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true, eng2: true, lightBeacon: true }));

  // TAXI → TAKEOFF_ROLL (gs > 60 kts on ground)
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 70, groundSpeed: 70, vs: 0, mach: 0.1, lightTaxi: true }));

  // TAKEOFF_ROLL → AIRBORNE (off ground)
  t.update(frame({ onGround: false, altitude: 100, altAgl: 100, ias: 160, groundSpeed: 160, vs: 500, mach: 0.24 }));

  // AIRBORNE → CLIMB
  t.update(frame({ onGround: false, altitude: 500, altAgl: 500, ias: 250, groundSpeed: 250, vs: 300, mach: 0.38 }));

  // CLIMB (stay in CLIMB for several frames)
  for (let i = 0; i < 5; i++) {
    t.update(frame({ altitude: 10000 + i * 5000, ias: 280, vs: 1500, mach: 0.55 + i * 0.03 }));
  }

  // CLIMB → CRUISE: altitude > 10000, vs between -200 and +200
  t.update(frame({ altitude: 35000, ias: 480, vs: 50, mach: 0.78 }));

  // One frame in CRUISE to confirm transition
  t.update(frame({ altitude: 35000, ias: 480, vs: 10, mach: 0.78 }));

  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

// ── A: Pre-flight beacon ──────────────────────────────────────────────────────
{
  console.log('\n── TEST A: Pre-flight beacon on ─────────────────────────────────────────');
  const t = buildTracker();
  // PRE_FLIGHT → TAXI with beacon ON
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true, lightBeacon: true }));
  // TAXI → TAKEOFF_ROLL
  t.update(frame({ onGround: true, altitude: 0, ias: 70, groundSpeed: 70, vs: 0, mach: 0.1 }));

  const rec = t._flightRecordSnapshot?.();  // private, access via known fields
  assert('_beaconOnBeforeTaxi = true when beacon on at TAXI entry', t._beaconOnBeforeTaxi === true, t._beaconOnBeforeTaxi, 'true');
}

{
  console.log('\n── TEST A2: Pre-flight beacon off ───────────────────────────────────────');
  const t = buildTracker();
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true, lightBeacon: false }));
  t.update(frame({ onGround: true, altitude: 0, ias: 70, groundSpeed: 70, vs: 0, mach: 0.1 }));
  assert('_beaconOnBeforeTaxi = false when beacon off at TAXI entry', t._beaconOnBeforeTaxi === false, t._beaconOnBeforeTaxi, 'false');
}

// ── B: Taxi-out speed / lights ────────────────────────────────────────────────
{
  console.log('\n── TEST B: Taxi-out max speed and light fraction ────────────────────────');
  const t = buildTracker();
  // PRE_FLIGHT → TAXI
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true }));
  // 4 TAXI frames: 2 with taxi light on, 2 off; max speed 35 kts
  t.update(frame({ onGround: true, altitude: 0, ias: 30, groundSpeed: 30, vs: 0, mach: 0, lightTaxi: true }));
  t.update(frame({ onGround: true, altitude: 0, ias: 35, groundSpeed: 35, vs: 0, mach: 0, lightTaxi: true }));
  t.update(frame({ onGround: true, altitude: 0, ias: 20, groundSpeed: 20, vs: 0, mach: 0, lightTaxi: false }));
  t.update(frame({ onGround: true, altitude: 0, ias: 25, groundSpeed: 25, vs: 0, mach: 0, lightTaxi: false }));
  // Transition to TAKEOFF_ROLL (this frame is ALSO counted in taxi scoring since
  // _accumulateScoring runs before _runStateMachine, so lightTaxi must be true
  // to keep the expected fraction at 3/5 = 0.6, or we test that the transition
  // frame counts. Here we include it as taxi-light-off to test 2/5=0.4).
  t.update(frame({ onGround: true, altitude: 0, ias: 70, groundSpeed: 70, vs: 0, mach: 0.1, lightTaxi: false }));

  // 5 total taxi frames (the 70kt transition frame is also counted): 2 lights on, 3 off = 2/5
  assert('taxiOut.maxSpeed captured before transition', t._taxiOutMaxSpeed >= 35, t._taxiOutMaxSpeed, '>= 35');
  assert('taxiOut.lightFraction = 0.4 (2/5 frames including transition frame)', Math.abs(t._taxiOutLightFraction - 0.4) < 0.01, t._taxiOutLightFraction, '0.4');
}

// ── C: Taxi-out turn violation ────────────────────────────────────────────────
{
  console.log('\n── TEST C: Taxi-out turn violation ──────────────────────────────────────');
  const t = buildTracker();
  // Use heading:0 on transition frame so _prevHeading=0 when TAXI begins
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true, heading: 0 }));
  // PRE_FLIGHT → TAXI uses heading:0 so _prevHeading starts at 0 after that frame.
  // First explicit TAXI frame also at heading 0 (so no delta yet).
  t.update(frame({ onGround: true, altitude: 0, ias: 20, groundSpeed: 20, vs: 0, mach: 0, heading: 0, lightTaxi: true }));
  // Turn 50° total at GS 20kt (> 15 turn limit → violation)
  t.update(frame({ onGround: true, altitude: 0, ias: 20, groundSpeed: 20, vs: 0, mach: 0, heading: 50, lightTaxi: true }));
  assert('1 turn violation when turn > 45° at GS 20kt', t._taxiOutTurnViolations === 1, t._taxiOutTurnViolations, 1);

  // Another turn slowly (GS <= 15 kt) → no violation
  const turnsBefore = t._taxiOutTurnViolations;
  t.update(frame({ onGround: true, altitude: 0, ias: 10, groundSpeed: 10, vs: 0, mach: 0, heading: 100, lightTaxi: true }));
  t.update(frame({ onGround: true, altitude: 0, ias: 10, groundSpeed: 10, vs: 0, mach: 0, heading: 150, lightTaxi: true }));
  assert('no violation when turn GS <= 15kt', t._taxiOutTurnViolations === turnsBefore, t._taxiOutTurnViolations, turnsBefore);
}

// ── D: Takeoff bank / pitch violations ───────────────────────────────────────
{
  console.log('\n── TEST D: Takeoff roll bank and pitch violations ───────────────────────');
  const t = buildTracker();
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true }));
  // Through TAXI
  t.update(frame({ onGround: true, altitude: 0, ias: 70, groundSpeed: 70, vs: 0, mach: 0.1 }));
  // Now in TAKEOFF_ROLL: bank 35° and pitch 25° → violations
  t.update(frame({ onGround: true, altitude: 0, ias: 100, groundSpeed: 100, vs: 0, mach: 0.15, bankAngle: 35, pitch: 25 }));
  // Normal frame in TAKEOFF_ROLL
  t.update(frame({ onGround: true, altitude: 0, ias: 130, groundSpeed: 130, vs: 0, mach: 0.19, bankAngle: 0, pitch: 10 }));

  assert('takeoff bank violation (35°)', t._takeoffBankViolations >= 1, t._takeoffBankViolations, '>= 1');
  assert('takeoff pitch violation (25°)', t._takeoffPitchViolations >= 1, t._takeoffPitchViolations, '>= 1');
}

// ── E: Tail strike detection ──────────────────────────────────────────────────
// Note: tested in TAKEOFF_ROLL phase to avoid _resetFlightRecord clearing the flag.
// PRE_FLIGHT→TAXI reset clears _tailStrike; it's only meaningful post-transition.
{
  console.log('\n── TEST E: Tail strike detection (in takeoff_roll phase) ────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'takeoff_roll'; // set phase directly to avoid reset
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 100, groundSpeed: 100, vs: 0, mach: 0.15, pitch: 11 }));
  assert('tail strike flagged at pitch 11° on ground (takeoff_roll)', t._tailStrike === true, t._tailStrike, 'true');
}

{
  console.log('\n── TEST E2: No tail strike below 10° ────────────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'takeoff_roll';
  t.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 100, groundSpeed: 100, vs: 0, mach: 0.15, pitch: 9 }));
  assert('no tail strike at pitch 9°', t._tailStrike === false, t._tailStrike, 'false');
}

// ── F: Climb speed violation below FL100 ─────────────────────────────────────
{
  console.log('\n── TEST F: Climb speed violation below FL100 ────────────────────────────');
  const t = trackerInCruise();
  // Hack: inject a CLIMB phase violation after the fact isn't easy without
  // driving from scratch. Let's drive from scratch for this one.
  const t2 = buildTracker();
  t2.update(frame({ onGround: true, altitude: 0, altAgl: 0, ias: 0, groundSpeed: 0, vs: 0, mach: 0, eng1: true }));
  t2.update(frame({ onGround: true, altitude: 0, ias: 70, groundSpeed: 70, vs: 0, mach: 0.1 }));
  // AIRBORNE
  t2.update(frame({ onGround: false, altitude: 100, altAgl: 100, ias: 160, groundSpeed: 160, vs: 500, mach: 0.24 }));
  // Force into CLIMB phase with high AGL
  t2.update(frame({ onGround: false, altitude: 500, altAgl: 500, ias: 250, groundSpeed: 250, vs: 300, mach: 0.38 }));
  // In CLIMB below 10000ft at 280kts (> 250 limit) → violation
  t2.update(frame({ altitude: 8000, altAgl: 8000, ias: 280, groundSpeed: 280, vs: 1200, mach: 0.42 }));
  t2.update(frame({ altitude: 9000, altAgl: 9000, ias: 270, groundSpeed: 270, vs: 1200, mach: 0.41 }));
  assert('climb speed violation below FL100 (ias 280 > 250)', t2._climbSpeedViolations >= 1, t2._climbSpeedViolations, '>= 1');
}

// ── G: Cruise mach RMS (unstable throttle) ────────────────────────────────────
{
  console.log('\n── TEST G: Cruise mach RMS — unstable throttle ──────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'cruise';
  t._cruiseEnteredAt   = Date.now() - 61000;
  t._cruiseAltTarget   = null;
  t._cruiseMachLock    = null;
  t._cruiseMachSamples = [];

  const unstableMachs = [0.72, 0.73, 0.70, 0.78, 0.72, 0.75];
  for (const m of unstableMachs) {
    t._accumulateScoring(frame({ altitude: 35000, mach: m, gForce: 1.0, bankAngle: 0 }));
  }
  t._cruiseMachRms = require('./src/flight-tracker').__rms
    ? require('./src/flight-tracker').__rms(t._cruiseMachSamples)
    : (() => {
        const vals = t._cruiseMachSamples;
        if (!vals.length) return 0;
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
        return Math.sqrt(variance);
      })();

  assert('machRms > 0.01 for unstable throttle', t._cruiseMachRms > 0.01, t._cruiseMachRms, '> 0.01');
}

// ── H: Cruise mach RMS (stable throttle) ─────────────────────────────────────
{
  console.log('\n── TEST H: Cruise mach RMS — stable throttle ────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'cruise';
  t._cruiseEnteredAt   = Date.now() - 61000;
  t._cruiseAltTarget   = null;  // will lock on first frame
  t._cruiseMachLock    = null;
  t._cruiseMachSamples = [];    // clean slate — critical for this test

  const stableMachs = [0.780, 0.780, 0.780, 0.780, 0.780, 0.780];
  for (const m of stableMachs) {
    t._accumulateScoring(frame({ altitude: 35000, mach: m, gForce: 1.0, bankAngle: 0 }));
  }

  // Compute RMS the same way the tracker does on CRUISE→DESCENT
  const vals = t._cruiseMachSamples;
  const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const variance = vals.length ? vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length : 0;
  const machRms = Math.sqrt(variance);

  assert('machRms = 0 for perfectly stable throttle', machRms < 0.001, machRms, '< 0.001');
  assert('mach samples collected after lock', t._cruiseMachSamples.length > 0, t._cruiseMachSamples.length, '> 0');
  assert('mach lock set to first sample', Math.abs(t._cruiseMachLock - 0.780) < 0.001, t._cruiseMachLock, '~0.780');
}

// ── I: Cruise altitude hold violation ────────────────────────────────────────
{
  console.log('\n── TEST I: Cruise altitude hold violation ───────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'cruise';
  t._cruiseEnteredAt   = Date.now() - 61000;
  t._cruiseAltTarget   = 35000;  // pre-locked
  t._cruiseMachLock    = 0.78;
  t._cruiseMachSamples = [];

  // 3 frames within tolerance, 2 frames outside
  t._accumulateScoring(frame({ altitude: 35050, mach: 0.78 }));  // ok
  t._accumulateScoring(frame({ altitude: 35100, mach: 0.78 }));  // exactly ±100 → ok (not > 100)
  t._accumulateScoring(frame({ altitude: 35101, mach: 0.78 }));  // violation
  t._accumulateScoring(frame({ altitude: 34899, mach: 0.78 }));  // violation
  t._accumulateScoring(frame({ altitude: 35000, mach: 0.78 }));  // ok

  assert('2 altitude violations when > ±100ft', t._cruiseAltViolations === 2, t._cruiseAltViolations, 2);
}

// ── J: Descent speed violation ────────────────────────────────────────────────
{
  console.log('\n── TEST J: Descent speed violation below FL100 ──────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'descent';

  t._accumulateScoring(frame({ altitude: 8000, ias: 270, groundSpeed: 270, vs: -800 }));  // violation (270 > 250)
  t._accumulateScoring(frame({ altitude: 9000, ias: 240, groundSpeed: 240, vs: -800 }));  // ok
  t._accumulateScoring(frame({ altitude: 12000, ias: 300, groundSpeed: 300, vs: -800 })); // ok (above FL100)

  assert('1 descent speed violation (270kts below FL100)', t._descentSpeedViolations === 1, t._descentSpeedViolations, 1);
}

// ── K: Approach — gear and flaps gate checks ──────────────────────────────────
{
  console.log('\n── TEST K: Approach gate checks at 1000 AGL ─────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'approach';

  // Frame just above 1000 AGL (no gate check yet)
  t._accumulateScoring(frame({ altAgl: 1200, gearDown: false, flapsIndex: 0, ias: 160, vs: -500, bankAngle: 0, pitch: -2 }));
  assert('gate not checked above 1000 AGL', !t._checkedAt1000, t._checkedAt1000, 'false');

  // Frame at exactly 1000 AGL with gear and flaps NOT set
  t._accumulateScoring(frame({ altAgl: 1000, gearDown: false, flapsIndex: 0, ias: 140, vs: -500, bankAngle: 0, pitch: -2 }));
  assert('gate checked at 1000 AGL', t._checkedAt1000, t._checkedAt1000, 'true');
  assert('gearDownBy1000 = false (gear not down)', !t._gearDownBy1000, t._gearDownBy1000, 'false');
  assert('flapsSetBy1000 = false (flapsIndex 0)', !t._flapsSetBy1000, t._flapsSetBy1000, 'false');
}

{
  console.log('\n── TEST K2: Approach — gear and flaps set correctly by 1000 AGL ─────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'approach';

  t._accumulateScoring(frame({ altAgl: 999, gearDown: true, flapsIndex: 3, ias: 140, vs: -500, bankAngle: 0, pitch: -2 }));
  assert('gearDownBy1000 = true', t._gearDownBy1000, t._gearDownBy1000, 'true');
  assert('flapsSetBy1000 = true (flapsIndex 3)', t._flapsSetBy1000, t._flapsSetBy1000, 'true');
}

// ── L: Stabilised approach gate at 500 AGL ────────────────────────────────────
{
  console.log('\n── TEST L: Stabilised approach at 500 AGL ───────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'approach';
  t._checkedAt1000 = true; // skip 1000 gate

  // Good stable approach: VS > -1000, bank <= 10°, pitch <= 10°, gear down
  t._accumulateScoring(frame({ altAgl: 499, gearDown: true, flapsIndex: 3, vs: -700, bankAngle: 5, pitch: -3, ias: 140 }));
  assert('stabilisedBelow500 = true for stable approach', t._stabilisedBelow500, t._stabilisedBelow500, 'true');
}

{
  console.log('\n── TEST L2: Unstabilised approach at 500 AGL — high VS ─────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'approach';
  t._checkedAt1000 = true;

  t._accumulateScoring(frame({ altAgl: 499, gearDown: true, vs: -1200, bankAngle: 3, pitch: -2, ias: 140 }));
  assert('stabilisedBelow500 = false for VS > 1000 fpm down', !t._stabilisedBelow500, t._stabilisedBelow500, 'false');
}

// ── M: Landing lights — must be off above FL180 ──────────────────────────────
{
  console.log('\n── TEST M: Landing lights off above FL180 during climb ──────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'climb';

  t._accumulateScoring(frame({ altitude: 19000, lightLanding: true }));  // violation (on above FL180)
  assert('landing lights violation: on above FL180 during climb', t._landingLightsViolation === true, t._landingLightsViolation, 'true');
}

{
  console.log('\n── TEST M2: Landing lights must be ON below FL180 during descent ────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'descent';

  t._accumulateScoring(frame({ altitude: 15000, lightLanding: false })); // violation
  assert('landing lights violation: off below FL180 during descent', t._landingLightsViolation === true, t._landingLightsViolation, 'true');
}

{
  console.log('\n── TEST M3: Landing lights ok — on below FL180 during approach ──────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'approach';

  t._accumulateScoring(frame({ altitude: 3000, lightLanding: true })); // ok
  assert('no landing lights violation: on below FL180 during approach', t._landingLightsViolation === false, t._landingLightsViolation, 'false');
}

// ── N: Strobe tracking ────────────────────────────────────────────────────────
{
  console.log('\n── TEST N: Strobe compliance tracking ───────────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'climb';

  t._accumulateScoring(frame({ lightStrobe: true }));   // on
  t._accumulateScoring(frame({ lightStrobe: false }));  // off — violation
  t._accumulateScoring(frame({ lightStrobe: true }));   // on

  assert('strobeTrackedFrames = 3', t._strobeTrackedFrames === 3, t._strobeTrackedFrames, 3);
  assert('strobeOffFrames = 1', t._strobeOffFrames === 1, t._strobeOffFrames, 1);
}

// ── O: Taxi-in checks ─────────────────────────────────────────────────────────
{
  console.log('\n── TEST O: Taxi-in lights and speed ─────────────────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'post_flight';

  // 3 frames: max speed 35kts, landing lights off, strobes off, taxi lights: 2/3 on
  t._accumulateScoring(frame({ onGround: true, groundSpeed: 35, lightLanding: false, lightStrobe: false, lightTaxi: true }));
  t._accumulateScoring(frame({ onGround: true, groundSpeed: 25, lightLanding: true, lightStrobe: true, lightTaxi: true }));
  t._accumulateScoring(frame({ onGround: true, groundSpeed: 15, lightLanding: false, lightStrobe: false, lightTaxi: false }));

  assert('taxiIn.maxSpeed = 35', t._taxiInMaxSpeed === 35, t._taxiInMaxSpeed, 35);
  assert('taxiInLandingLightsOff = true (lights off on some frames)', t._taxiInLandingLightsOff === true, t._taxiInLandingLightsOff, 'true');
  assert('taxiInStrobesOff = true (strobe off on some frames)', t._taxiInStrobesOff === true, t._taxiInStrobesOff, 'true');
  assert('taxiIn lightFraction is computed later (still 1.0)', t._taxiInLightFraction === 1.0, t._taxiInLightFraction, '1.0 (computed at completeFlight)');
  assert('taxiInLightOnFrames = 2 (taxi light on 2/3 frames)', t._taxiInLightOnFrames === 2, t._taxiInLightOnFrames, 2);
  assert('taxiInFrameCount = 3', t._taxiInFrameCount === 3, t._taxiInFrameCount, 3);
}

// ── P: Heavy 4-engine speed exception ────────────────────────────────────────
{
  console.log('\n── TEST P: Heavy 4-engine climb speed exception ─────────────────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'climb';
  t._aircraftTypeCode = 'B744';

  // 280kts below FL100 is ok for B744 (limit is 300)
  t._accumulateScoring(frame({ altitude: 9000, ias: 280, vs: 1200 }));
  assert('B744: 280kts below FL100 = no violation (limit 300)', t._climbSpeedViolations === 0, t._climbSpeedViolations, 0);

  // 310kts → violation even for B744
  t._accumulateScoring(frame({ altitude: 9000, ias: 310, vs: 1200 }));
  assert('B744: 310kts below FL100 = 1 violation', t._climbSpeedViolations === 1, t._climbSpeedViolations, 1);
}

// ── Q: Approach average speed (airborne only) ─────────────────────────────────
{
  console.log('\n── TEST Q: Approach average speed excludes onGround frames ──────────────');
  const t = new FlightTracker();
  t.start();
  t._phase = 'approach';

  // 2 airborne frames with ias 140 and 160 (below 2000 AGL)
  t._accumulateScoring(frame({ altAgl: 1500, ias: 140, vs: -600, onGround: false }));
  t._accumulateScoring(frame({ altAgl: 1000, ias: 160, vs: -600, onGround: false }));
  // Touchdown frame (onGround: true) should NOT be included
  t._accumulateScoring(frame({ altAgl: 0, ias: 0, vs: -300, onGround: true }));

  assert('approach speed samples = 2 (excludes onGround)', t._approachSpeedSamples.length === 2, t._approachSpeedSamples.length, 2);
  const avg = t._approachSpeedSamples.reduce((s, v) => s + v, 0) / t._approachSpeedSamples.length;
  assert('average approach speed = 150kts', Math.abs(avg - 150) < 1, avg, '150');
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(72)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
