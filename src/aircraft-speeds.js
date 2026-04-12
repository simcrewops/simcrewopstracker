'use strict';

/**
 * Aircraft speed lookup table.
 * Maps IATA/common aircraft type codes → { vr, vapp } in knots.
 * vr   = rotation speed (average, typical weights)
 * vapp = approach/reference speed (average, typical weights)
 */
const AIRCRAFT_SPEEDS = {
  // CRJ family
  'CRJ2':  { vr: 130, vapp: 125 },
  'CRJ7':  { vr: 138, vapp: 130 },
  'CRJ9':  { vr: 140, vapp: 133 },
  'CRJ-900': { vr: 140, vapp: 133 },

  // Embraer E-jets
  'E170':  { vr: 132, vapp: 128 },
  'E175':  { vr: 134, vapp: 130 },
  'E190':  { vr: 140, vapp: 135 },
  'E195':  { vr: 143, vapp: 138 },

  // Airbus narrowbody
  'A319':  { vr: 138, vapp: 132 },
  'A320':  { vr: 143, vapp: 137 },
  'A321':  { vr: 150, vapp: 142 },

  // Boeing 737 family
  'B737':  { vr: 140, vapp: 133 },
  'B738':  { vr: 145, vapp: 138 },
  'B739':  { vr: 148, vapp: 140 },

  // Boeing 757
  'B752':  { vr: 155, vapp: 145 },
  'B753':  { vr: 158, vapp: 148 },

  // Boeing 767
  'B763':  { vr: 157, vapp: 147 },

  // Boeing 777
  'B77W':  { vr: 165, vapp: 155 },
  'B772':  { vr: 163, vapp: 153 },

  // Airbus widebody
  'A332':  { vr: 158, vapp: 148 },
  'A333':  { vr: 160, vapp: 150 },

  // Turboprops
  'DH8D':  { vr: 107, vapp: 110 },
  'AT72':  { vr: 108, vapp: 112 },
  'SF34':  { vr:  98, vapp: 100 },
};

const DEFAULT_SPEEDS = { vr: 140, vapp: 135 };

/**
 * Returns { vr, vapp } in knots for the given IATA/type code.
 * Falls back to defaults if the type is unknown.
 * @param {string} typeCode
 * @returns {{ vr: number, vapp: number }}
 */
function getAircraftSpeeds(typeCode) {
  if (!typeCode) return DEFAULT_SPEEDS;
  const key = typeCode.toUpperCase().trim();
  return AIRCRAFT_SPEEDS[key] ?? DEFAULT_SPEEDS;
}

module.exports = { getAircraftSpeeds };
