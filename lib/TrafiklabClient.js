'use strict';

const https = require('https');
const { URL } = require('url');
const TrafiklabError = require('./TrafiklabError');
const { normalizeStopGroups, normalizeBoardItems } = require('./DataNormalizer');

/**
 * HTTP client for the Trafiklab Realtime API.
 *
 * Base URL:  https://realtime-api.trafiklab.se/v1/
 * Auth:      ?key={apiKey}  (query parameter, never in logs)
 * License:   CC-BY 4.0 — attribution required: "Data from Trafiklab.se"
 *
 * Endpoints used:
 *   GET /stops/name/{query}?key=…          Stop lookup (rikshållplats search)
 *   GET /departures/{areaId}?key=…         Departures in next 60 min
 *   GET /arrivals/{areaId}?key=…           Arrivals in next 60 min
 *
 * The server caches responses for 60 seconds. There is no benefit to calling
 * more often than once per minute. Rate limits (Bronze tier): 25 req/min,
 * 100 000 req/month. This client enforces a minimum interval between requests
 * to the same resource.
 */

const BASE_URL = 'https://realtime-api.trafiklab.se/v1';
const REQUEST_TIMEOUT_MS = 12000; // 12 s — generous, API is usually <1 s

// TTL constants — aligned with the Trafiklab server-side cache window.
// Departures/arrivals: 60 s (server refreshes no faster than this).
// Stop search results: 24 h (rikshållplats IDs are stable).
const DEPARTURES_CACHE_TTL_MS = 60 * 1000;
const STOPS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

class TrafiklabClient {
  /**
   * @param {object}       opts
   * @param {string}       opts.apiKey
   * @param {Function}     opts.log       this.log from Homey.App
   * @param {boolean}      [opts.debug]   Enable verbose request logging
   * @param {CacheManager} [opts.cache]   Shared TTL cache (injected by app.js)
   */
  constructor({ apiKey, log, debug = false, cache = null }) {
    this._apiKey = apiKey || '';
    this._log = log || (() => {});
    this._debug = debug;
    this._cache = cache;
    // In-flight promise deduplication: key → Promise
    // Prevents N simultaneous devices from all firing the same request
    this._inflight = new Map();
  }

  setApiKey(key) {
    this._apiKey = key || '';
  }

  setDebug(enabled) {
    this._debug = Boolean(enabled);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Search for stop groups (rikshållplatser) matching the query string.
   * Results are suitable for populating the pairing picker.
   *
   * @param {string} query  At least 1 character
   * @returns {Promise<Stop[]>}
   * @throws {TrafiklabError}
   */
  async searchStops(query) {
    this._requireApiKey();
    if (!query || String(query).trim().length === 0) {
      throw new TrafiklabError('Search query must not be empty', 'INVALID_INPUT');
    }

    const encoded = encodeURIComponent(String(query).trim());
    const url = `${BASE_URL}/stops/name/${encoded}`;
    const raw = await this._get(url, `stops:${encoded}`, STOPS_CACHE_TTL_MS);
    return normalizeStopGroups(raw);
  }

  /**
   * Fetch the next ~60 minutes of departures for a rikshållplats.
   *
   * @param {string} areaId  Stop group ID from searchStops()
   * @returns {Promise<BoardItem[]>}
   * @throws {TrafiklabError}
   */
  async getDepartures(areaId) {
    this._requireApiKey();
    if (!areaId) throw new TrafiklabError('areaId is required', 'INVALID_INPUT');

    const url = `${BASE_URL}/departures/${encodeURIComponent(areaId)}`;
    const raw = await this._get(url, `departures:${areaId}`);
    return normalizeBoardItems(raw, 'departure');
  }

  /**
   * Fetch the next ~60 minutes of arrivals for a rikshållplats.
   *
   * @param {string} areaId  Stop group ID from searchStops()
   * @returns {Promise<BoardItem[]>}
   * @throws {TrafiklabError}
   */
  async getArrivals(areaId) {
    this._requireApiKey();
    if (!areaId) throw new TrafiklabError('areaId is required', 'INVALID_INPUT');

    const url = `${BASE_URL}/arrivals/${encodeURIComponent(areaId)}`;
    const raw = await this._get(url, `arrivals:${areaId}`);
    return normalizeBoardItems(raw, 'arrival');
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Perform a GET request with TTL caching, in-flight deduplication, and
   * typed error translation.
   *
   * Lookup order:
   *   1. TTL cache (CacheManager) — returns immediately, no HTTP
   *   2. In-flight dedup map — shares one in-progress HTTP round-trip
   *   3. Fresh HTTPS GET — result is stored in the TTL cache on success
   *
   * @param {string} url        Base URL (without API key)
   * @param {string} cacheKey   Stable cache / dedup key for this resource
   * @param {number} [ttlMs]    TTL for this resource; defaults to DEPARTURES_CACHE_TTL_MS
   *
   * NOTE: The API key is appended as a query parameter here. Never log the
   * full URL — use _safeUrl() when logging.
   */
  async _get(url, cacheKey, ttlMs = DEPARTURES_CACHE_TTL_MS) {
    // --- Layer 1: TTL cache ---
    if (this._cache) {
      const cached = this._cache.get(cacheKey);
      if (cached !== undefined) {
        this._debugLog(`[cache] hit: ${cacheKey}`);
        return cached;
      }
    }

    // --- Layer 2: In-flight dedup ---
    if (this._inflight.has(cacheKey)) {
      this._debugLog(`[dedup] inflight hit: ${cacheKey}`);
      return this._inflight.get(cacheKey);
    }

    // --- Layer 3: Fresh HTTP request ---
    const fullUrl = this._buildUrl(url);
    this._debugLog(`[http] GET ${this._safeUrl(url)}`);

    const promise = this._httpGet(fullUrl)
      .then(data => {
        if (this._cache) {
          this._cache.set(cacheKey, data, ttlMs);
          this._debugLog(`[cache] stored: ${cacheKey} (ttl=${ttlMs}ms)`);
        }
        this._inflight.delete(cacheKey);
        return data;
      })
      .catch(err => {
        this._inflight.delete(cacheKey);
        throw err;
      });

    // Register in-flight before awaiting so concurrent callers share it
    this._inflight.set(cacheKey, promise);

    return promise;
  }

  _buildUrl(base) {
    const u = new URL(base);
    u.searchParams.set('key', this._apiKey);
    return u.toString();
  }

  /** Remove the API key from a URL for safe logging. */
  _safeUrl(url) {
    return url.replace(/[?&]key=[^&]*/gi, '?key=***');
  }

  /**
   * Low-level HTTPS GET returning parsed JSON.
   * Translates HTTP and network errors into TrafiklabError instances.
   */
  _httpGet(urlString) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(urlString);
      } catch (e) {
        return reject(new TrafiklabError(`Invalid URL: ${e.message}`, 'INVALID_INPUT'));
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'HomeyApp/TrafiklabDepartures/1.0',
        },
      };

      const req = https.request(options, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          this._debugLog(`[http] ${res.statusCode} (${body.length} bytes)`);
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new TrafiklabError(
                `Malformed JSON response: ${e.message}`,
                'PARSE',
              ));
            }
            return;
          }
          reject(this._httpErrorFromStatus(res.statusCode, body));
        });
      });

      req.on('error', err => {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
          reject(new TrafiklabError(`Network error: ${err.message}`, 'NETWORK'));
        } else if (err.message && err.message.includes('socket hang up')) {
          reject(new TrafiklabError('Connection dropped by server', 'NETWORK'));
        } else {
          reject(new TrafiklabError(`Network error: ${err.message}`, 'NETWORK'));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new TrafiklabError(
          `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          'TIMEOUT',
        ));
      });

      req.setTimeout(REQUEST_TIMEOUT_MS);
      req.end();
    });
  }

  _httpErrorFromStatus(statusCode, body) {
    let detail = '';
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.error || '';
    } catch { /* body wasn't JSON */ }

    switch (statusCode) {
      case 401:
        return new TrafiklabError(
          'Invalid or missing Trafiklab API key. Check App Settings.',
          'INVALID_KEY',
          401,
        );
      case 403:
        return new TrafiklabError(
          'Access forbidden. Your API key may lack permission for this endpoint.',
          'FORBIDDEN',
          403,
        );
      case 404:
        return new TrafiklabError(
          'Stop not found. The stop ID may be invalid.',
          'NOT_FOUND',
          404,
        );
      case 429:
        return new TrafiklabError(
          'Rate limit exceeded. Reduce polling frequency or upgrade Trafiklab tier.',
          'RATE_LIMIT',
          429,
        );
      case 500:
      case 502:
      case 503:
        return new TrafiklabError(
          `Trafiklab server error (${statusCode}). Retrying later.${detail ? ` ${detail}` : ''}`,
          'SERVER',
          statusCode,
        );
      default:
        return new TrafiklabError(
          `Unexpected HTTP ${statusCode}${detail ? `: ${detail}` : ''}`,
          'UNKNOWN',
          statusCode,
        );
    }
  }

  _requireApiKey() {
    if (!this._apiKey || this._apiKey.trim() === '') {
      throw new TrafiklabError(
        'Trafiklab API key is not set. Go to App Settings and enter your key.',
        'MISSING_KEY',
      );
    }
  }

  _debugLog(message) {
    if (this._debug) this._log(`[TrafiklabClient] ${message}`);
  }
}

module.exports = TrafiklabClient;
