'use strict';

/**
 * SimCrewOps API client
 *
 * Sends completed flight records to simcrewops.com via the REST API.
 * Authentication uses a Clerk session token obtained fresh before each request.
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

class ApiClient {
  /**
   * @param {string} baseUrl - The web app base URL
   * @param {() => Promise<string|null>} getToken - Async function that returns a fresh Clerk JWT
   */
  constructor(baseUrl, getToken) {
    this._baseUrl  = (baseUrl || 'https://simcrewops.com').replace(/\/$/, '');
    this._getToken = getToken || (async () => null);
  }

  setBaseUrl(url)    { this._baseUrl  = (url || 'https://simcrewops.com').replace(/\/$/, ''); }
  setGetToken(fn)    { this._getToken = fn; }

  /**
   * Submit a completed flight record to /api/sim-sessions
   * @param {Object} flightRecord
   * @returns {Promise<Object>} The created session from the server
   */
  async submitFlight(flightRecord) {
    const token = await this._getToken();
    if (!token) {
      throw new Error('Not signed in. Please sign in to SimCrewOps first.');
    }

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
    };

    const response = await this._request('POST', '/api/sim-sessions', body, token);
    return response.data;
  }

  /**
   * Send a heartbeat so the web app knows the tracker is running.
   * Called periodically (~30 s) by main.js. Silently ignores errors.
   */
  async sendHeartbeat() {
    const token = await this._getToken();
    if (!token) return;
    try {
      await this._request('POST', '/api/tracker/heartbeat', {}, token);
    } catch {
      // intentionally silent
    }
  }

  /**
   * Internal HTTP request helper (uses native https/http modules, no axios)
   */
  _request(method, path, body, token) {
    return new Promise((resolve, reject) => {
      const url = new URL(this._baseUrl + path);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const bodyStr = body ? JSON.stringify(body) : null;

      const headers = {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'User-Agent':    'SimCrewOps-Tracker/1.0',
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const options = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers,
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
