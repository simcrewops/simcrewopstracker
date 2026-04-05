'use strict';

/**
 * ACARS Client
 *
 * Manages ACARS message polling, PIREP submission, and PIREP retrieval
 * for the SimCrewOps desktop tracker. Extends the existing API client
 * pattern with ACARS-specific endpoints.
 */

const { EventEmitter } = require('events');

// How often to poll for nearby PIREPs (ms)
const PIREP_POLL_INTERVAL = 60_000; // 1 minute

class AcarsClient extends EventEmitter {
  /**
   * @param {import('./api-client')} apiClient — existing ApiClient instance
   */
  constructor(apiClient) {
    super();
    this._api = apiClient;
    this._flightId = null;
    this._messages = [];        // all received ACARS messages this flight
    this._pireps = [];           // nearby PIREPs
    this._lastPhase = null;
    this._pirepPollTimer = null;
    this._lastPosition = null;   // { lat, lon, altitude }
    this._active = false;
  }

  /**
   * Start ACARS for a flight. Generates the event queue on the server and
   * begins PIREP polling.
   *
   * @param {Object} flightInfo
   * @param {string} flightInfo.flightId
   * @param {string} flightInfo.departure
   * @param {string} flightInfo.arrival
   * @param {string} flightInfo.flightNumber
   * @param {string} flightInfo.aircraftType
   * @param {number} [flightInfo.blockTime]
   */
  async startFlight(flightInfo) {
    this._flightId = flightInfo.flightId;
    this._messages = [];
    this._pireps = [];
    this._active = true;

    // Generate ACARS event queue on the server
    try {
      const result = await this._api._request('POST', '/api/acars/events', {
        flightId:     flightInfo.flightId,
        departure:    flightInfo.departure,
        arrival:      flightInfo.arrival,
        flightNumber: flightInfo.flightNumber,
        aircraftType: flightInfo.aircraftType,
        blockTime:    flightInfo.blockTime ?? 120,
      });
      this.emit('events-generated', result);
    } catch (err) {
      this.emit('error', { action: 'generate-events', error: err.message });
    }

    // Start PIREP polling
    this._startPirepPolling();
  }

  /**
   * Stop ACARS for the current flight.
   */
  stopFlight() {
    this._active = false;
    this._flightId = null;
    this._stopPirepPolling();
  }

  /**
   * Called on every phase transition. Fetches any undelivered messages
   * for the new phase from the server.
   *
   * @param {string} phase — e.g. 'pre_flight', 'cruise', 'descent'
   */
  async onPhaseChange(phase) {
    if (!this._active || !this._flightId) return;
    this._lastPhase = phase;

    try {
      const result = await this._api._request(
        'GET',
        `/api/acars/messages?flightId=${encodeURIComponent(this._flightId)}&phase=${encodeURIComponent(phase)}`
      );

      const newMessages = result.data || [];
      if (newMessages.length > 0) {
        this._messages.push(...newMessages);
        this.emit('messages', newMessages);
      }
    } catch (err) {
      this.emit('error', { action: 'fetch-messages', error: err.message });
    }
  }

  /**
   * Update current position (called from SimConnect data frames).
   * Used for PIREP proximity queries.
   *
   * @param {{ lat: number, lon: number, altitude: number }} pos
   */
  updatePosition(pos) {
    this._lastPosition = pos;
  }

  /**
   * Submit a PIREP from this pilot.
   *
   * @param {Object} pirep
   * @param {string} pirep.type — TURBULENCE, ICING, VISIBILITY, WINDS
   * @param {string} pirep.severity — LIGHT, MODERATE, SEVERE, EXTREME
   * @param {string} [pirep.message]
   * @returns {Promise<Object>} the created PIREP
   */
  async submitPirep(pirep) {
    if (!this._lastPosition) {
      throw new Error('No position data available. Connect to SimConnect first.');
    }

    const body = {
      flightId: this._flightId || undefined,
      lat:      this._lastPosition.lat,
      lon:      this._lastPosition.lon,
      altitude: this._lastPosition.altitude,
      type:     pirep.type,
      severity: pirep.severity,
      message:  pirep.message || undefined,
    };

    const result = await this._api._request('POST', '/api/acars/pirep', body);
    this.emit('pirep-submitted', result.data);
    return result.data;
  }

  /**
   * Fetch nearby PIREPs from other players.
   * @returns {Promise<Array>}
   */
  async fetchNearbyPireps() {
    if (!this._lastPosition) return [];

    try {
      const { lat, lon, altitude } = this._lastPosition;
      const result = await this._api._request(
        'GET',
        `/api/acars/pireps?lat=${lat}&lon=${lon}&alt=${altitude}`
      );

      const pireps = result.data || [];

      // Detect new PIREPs that weren't in the previous set
      const existingIds = new Set(this._pireps.map(p => p.id));
      const newPireps = pireps.filter(p => !existingIds.has(p.id) && !p.isOwn);

      this._pireps = pireps;

      if (newPireps.length > 0) {
        this.emit('pirep-alerts', newPireps);
      }

      this.emit('pireps-updated', pireps);
      return pireps;
    } catch (err) {
      this.emit('error', { action: 'fetch-pireps', error: err.message });
      return [];
    }
  }

  /**
   * Get all received ACARS messages for the current flight.
   * @returns {Array}
   */
  getMessages() {
    return this._messages;
  }

  /**
   * Get currently known nearby PIREPs.
   * @returns {Array}
   */
  getPireps() {
    return this._pireps;
  }

  _startPirepPolling() {
    this._stopPirepPolling();
    this._pirepPollTimer = setInterval(() => {
      if (this._active && this._lastPosition) {
        this.fetchNearbyPireps();
      }
    }, PIREP_POLL_INTERVAL);
    // Also fetch immediately
    if (this._lastPosition) {
      this.fetchNearbyPireps();
    }
  }

  _stopPirepPolling() {
    if (this._pirepPollTimer) {
      clearInterval(this._pirepPollTimer);
      this._pirepPollTimer = null;
    }
  }
}

module.exports = AcarsClient;
