'use strict';

/**
 * Simple in-memory TTL cache.
 *
 * Used to avoid redundant API calls when multiple devices monitor the same
 * stop, and to respect the fact that the Trafiklab Realtime API already
 * caches responses server-side for 60 seconds.
 *
 * Entries are stored as { value, expiresAt } objects. Stale entries are
 * evicted lazily on read, with an optional periodic sweep.
 */
class CacheManager {
  constructor({ sweepIntervalMs = 5 * 60 * 1000 } = {}) {
    this._store = new Map();

    // Periodic sweep to prevent unbounded memory growth
    this._sweepTimer = setInterval(() => this._sweep(), sweepIntervalMs);
    // Allow the Node process to exit even if this timer is still live
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  /**
   * Store a value under key for ttlMs milliseconds.
   * @param {string} key
   * @param {*} value
   * @param {number} ttlMs  Time-to-live in milliseconds
   */
  set(key, value, ttlMs) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Retrieve a cached value, or undefined if absent / expired.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Check whether key is present and not expired.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * How many seconds ago was this entry cached, or -1 if missing.
   * Useful for the cache_age_seconds flow token.
   * @param {string} key
   * @param {number} ttlMs  The TTL that was used when storing
   * @returns {number}
   */
  ageSeconds(key, ttlMs) {
    const entry = this._store.get(key);
    if (!entry) return -1;
    const storedAt = entry.expiresAt - ttlMs;
    return Math.round((Date.now() - storedAt) / 1000);
  }

  /**
   * Remove a specific cache entry.
   * @param {string} key
   */
  invalidate(key) {
    this._store.delete(key);
  }

  /**
   * Remove all entries whose keys start with prefix.
   * Useful for invalidating all entries for a given stop.
   * @param {string} prefix
   */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  /** Remove all expired entries. */
  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this._store.entries()) {
      if (now > entry.expiresAt) this._store.delete(key);
    }
  }

  /** Clear everything and stop the sweep timer. Call on app uninit. */
  destroy() {
    clearInterval(this._sweepTimer);
    this._store.clear();
  }
}

module.exports = CacheManager;
