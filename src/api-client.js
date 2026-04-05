'use strict';

/**
 * SimCrewOps API client
 *
 * Sends completed flight records to simcrewops.com via the REST API.
 * Authentication: Bearer token stored in app settings.
 *
 * Methods:
 *   submitFlight(record)  → POST /api/sim-sessions   (legacy V4 submit)
 *   scoreFlight(record)   → POST /api/flights/score  (V5 scoring + debrief)
 *   verifyToken()         → GET  /api/tracker-key
 *   sendHeartbeat()       → POST /api/tracker/heartbeat  (silent)
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

class ApiClient {
  constructor(baseUrl, token) {
    this._baseUrl = (baseUrl || 'https://simcrewops.com').replace(/\/$/, '');
    this._token   = token || '';
  }

  setBaseUrl(url) { this._baseUrl = (url || 'https://simcrewops.com').replace(/\/$/, ''); }
  setToken(token) { this._token = token || ''; }

  /**
   * Submit a completed flight for V5 scoring.
   * Sends tick data along with summary for full phase-by-phase scoring.
   * Returns a debrief object with grade, breakdown, and pay calculation.
   *
   * Falls back gracefully if the endpoint doesn't exist yet (404 → throws).
   */
  async scoreFlight(flightRecord) {
    if (!this._token) {
      throw new Error('No API token configured.');
    }

    // Send the full record including ticks, but strip routePoints to avoid
    // sending large arrays that aren't needed for scoring.
    const body = {
      sessionDate:      flightRecord.sessionDate,
      aircraft:         flightRecord.aircraft   ?? 'UNKN',
      isHeavy:          flightRecord.isHeavy    ?? false,
      engineCount:      flightRecord.engineCount ?? 2,
      departure:        flightRecord.departure  ?? null,
      arrival:          flightRecord.arrival    ?? null,
      duration:         Math.max(1, flightRecord.duration  ?? 1),
      airTime:          flightRecord.airTime    ?? null,
      groundTime:       flightRecord.groundTime ?? null,
      landingRate:      flightRecord.landingRate ?? null,
      touchdownZoneHit: flightRecord.touchdownZoneHit ?? null,
      bounceCount:      flightRecord.bounceCount     ?? 0,
      touchdownGForce:  flightRecord.touchdownGForce ?? null,
      touchdownBank:    flightRecord.touchdownBank   ?? null,
      touchdownPitch:   flightRecord.touchdownPitch  ?? null,
      maxAltitude:      flightRecord.maxAltitude ?? null,
      maxGForce:        flightRecord.maxGForce   ?? null,
      fuelUsed:         flightRecord.fuelUsed    ?? null,
      cruiseAlt:        flightRecord.cruiseAlt   ?? null,
      ticks:            flightRecord.ticks       ?? [],
      landingTicks:     flightRecord.landingTicks ?? [],
      simVersion:       flightRecord.simVersion  ?? 'MSFS 2024',
      source:           'simconnect',
    };

    return this._request('POST', '/api/flights/score', body);
  }

  /**
   * Legacy submit — posts to /api/sim-sessions (V4 format).
   * Used as fallback when /api/flights/score is not available.
   */
  async submitFlight(flightRecord) {
    if (!this._token) {
      throw new Error('No API token configured. Please add your tracker API key in Settings.');
    }

    // Downsample routePoints to every 5th point to keep the payload small.
    // The full array can be up to ~2160 points (~180 kB JSON); 5x reduction → ~36 kB.
    const rawRoute = flightRecord.routePoints ?? [];
    const routePoints = rawRoute.filter((_, i) => i % 5 === 0);

    const body = {
      sessionDate:      flightRecord.sessionDate      ?? new Date().toISOString().split('T')[0],
      aircraft:         flightRecord.aircraft          ?? 'UNKN',
      departure:        flightRecord.departure         ?? null,
      arrival:          flightRecord.arrival           ?? null,
      duration:         Math.max(1, flightRecord.duration ?? 1),
      airTime:          flightRecord.airTime           ?? null,
      groundTime:       flightRecord.groundTime        ?? null,
      landingRate:      flightRecord.landingRate       ?? null,
      touchdownZoneHit: flightRecord.touchdownZoneHit ?? null,
      maxAltitude:      flightRecord.maxAltitude       ?? null,
      maxGForce:        flightRecord.maxGForce         ?? null,
      simVersion:       flightRecord.simVersion        ?? 'MSFS 2024',
      source:           'simconnect',
      routePoints,
      // V5 scoring input — present when ScoringCollector is wired in
      scoringInput:     flightRecord.scoringInput      ?? null,
    };

    const response = await this._request('POST', '/api/sim-sessions', body);
    return response.data;
  }

  async verifyToken() {
    try {
      await this._request('GET', '/api/tracker-key');
      return true;
    } catch {
      return false;
    }
  }

  /** Silently ignored on failure — heartbeat must never disrupt tracking. */
  async sendHeartbeat() {
    if (!this._token) return;
    try {
      await this._request('POST', '/api/tracker/heartbeat', {});
    } catch {
      // intentionally silent
    }
  }

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url     = new URL(this._baseUrl + urlPath);
      const isHttps = url.protocol === 'https:';
      const lib     = isHttps ? https : http;
      const bodyStr = body ? JSON.stringify(body) : null;

      const options = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers: {
          'Content-Type':  'application/json',
          'Accept':        'application/json',
          'Authorization': `Bearer ${this._token}`,
          'User-Agent':    'SimCrewOps-Tracker/1.0',
        },
      };
      if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error ?? `HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          } catch {
            reject(new Error(`Invalid JSON response (HTTP ${res.statusCode})`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Request timed out after 15 seconds'));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

module.exports = ApiClient;
