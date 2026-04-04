'use strict';

/**
 * SimCrewOps API client
 *
 * Sends completed flight records to simcrewops.com via the REST API.
 * Authentication uses a Bearer token stored in app settings.
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
   * Submit a completed flight record to /api/sim-sessions
   * @param {Object} flightRecord
   * @returns {Promise<Object>} The created session from the server
   */
  async submitFlight(flightRecord) {
    if (!this._token) {
      throw new Error('No API token configured. Please add your tracker API key in Settings.');
    }

    const body = {
      sessionDate:      flightRecord.sessionDate      ?? new Date().toISOString().split('T')[0],
      aircraft:         flightRecord.aircraft          ?? 'UNKN',
      departure:        flightRecord.departure         ?? null,
      arrival:          flightRecord.arrival           ?? null,
      duration:         Math.max(1, flightRecord.duration ?? 1),
      airTime:          flightRecord.airTime           ?? null,  // hours wheels-up to wheels-down
      groundTime:       flightRecord.groundTime        ?? null,  // hours on ground (block minus air)
      landingRate:      flightRecord.landingRate       ?? null,
      touchdownZoneHit: flightRecord.touchdownZoneHit ?? null,  // bool: landed in first 1000-1500ft
      maxAltitude:      flightRecord.maxAltitude       ?? null,
      maxGForce:        flightRecord.maxGForce         ?? null,
      simVersion:       flightRecord.simVersion        ?? 'MSFS 2024',
      source:           'simconnect',
    };

    const response = await this._request('POST', '/api/sim-sessions', body);
    return response.data;
  }

  /**
   * Verify the current API token is valid
   * @returns {Promise<boolean>}
   */
  async verifyToken() {
    try {
      await this._request('GET', '/api/tracker-key');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Internal HTTP request helper (uses native https/http modules, no axios)
   */
  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this._baseUrl + path);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

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

      if (bodyStr) {
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(
                parsed.error ?? `HTTP ${res.statusCode}: ${res.statusMessage}`
              ));
            }
          } catch {
            reject(new Error(`Invalid JSON response (HTTP ${res.statusCode})`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Network error: ${err.message}`));
      });

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
