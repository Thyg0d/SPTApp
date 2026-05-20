'use strict';

const Homey = require('homey');
const TrafiklabClient = require('./lib/TrafiklabClient');
const CacheManager = require('./lib/CacheManager');

/**
 * Trafiklab Departures — main Homey app entry point.
 *
 * Responsibilities:
 *  - Create shared TrafiklabClient and CacheManager instances
 *  - React to API key / debug setting changes and propagate to the client
 *  - Expose client + cache to drivers and devices via this.homey.app
 *
 * Data attribution: "Data from Trafiklab.se" (CC-BY 4.0)
 */
class TrafiklabApp extends Homey.App {
  async onInit() {
    this.log('Trafiklab Departures app initialising...');

    // Shared cache — all devices share this to avoid duplicate requests
    this.cache = new CacheManager();

    // Shared API client — cache is injected so all devices share one TTL store
    this.client = new TrafiklabClient({
      apiKey: this.homey.settings.get('apiKey') || '',
      log: this.log.bind(this),
      debug: Boolean(this.homey.settings.get('debugLogging')),
      cache: this.cache,
    });

    // React to settings changes so devices pick up a new API key immediately
    this.homey.settings.on('set', key => {
      if (key === 'apiKey') {
        const newKey = this.homey.settings.get('apiKey') || '';
        this.client.setApiKey(newKey);
        this.log('API key updated');
        // Invalidate all cached API responses so fresh data is fetched next poll
        this.cache.invalidatePrefix('departures:');
        this.cache.invalidatePrefix('arrivals:');
      }
      if (key === 'debugLogging') {
        this.client.setDebug(Boolean(this.homey.settings.get('debugLogging')));
      }
    });

    this.log('Trafiklab Departures app ready. Data from Trafiklab.se (CC-BY 4.0)');
  }

  async onUninit() {
    this.cache.destroy();
  }

  // Convenience accessors used by drivers and devices
  getClient() { return this.client; }
  getCache() { return this.cache; }
}

module.exports = TrafiklabApp;
