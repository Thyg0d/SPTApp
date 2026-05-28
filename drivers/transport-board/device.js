'use strict';

const Homey = require('homey');
const TrafiklabError = require('../../lib/TrafiklabError');
const { formatTime, minutesUntil } = require('../../lib/DataNormalizer');

/** Return the effective ISO time for a BoardItem (realtime if available). */
function effectiveIso(item) {
  return (item.realtimeAvailable && item.realtimeTime) ? item.realtimeTime : item.scheduledTime;
}

/**
 * TransportBoardDevice — represents one monitored stop/station.
 *
 * Each device:
 *  - Polls the Trafiklab API on a configurable interval
 *  - Applies optional filters (transport type, line, destination)
 *  - Updates capabilities visible in the Homey UI
 *  - Fires flow triggers with rich tokens:
 *      departure_updated   — every successful poll
 *      departure_soon      — once per departure, when countdown ≤ user threshold
 *      departure_delayed   — when a delay appears or grows for the current departure
 *      departure_cancelled — when the top filtered departure becomes cancelled
 *      departure_on_time   — when a previously-delayed departure clears its delay
 *
 * Per-departure state (reset when a new departure becomes #1 in the queue):
 *   _prevMins          — countdown from the previous poll (for threshold-crossing detection)
 *   _prevDepartureKey  — composite key of the departure at front of queue last poll
 *   _prevDelayMinutes  — delay value seen last poll (drives delayed / on_time triggers)
 *   _prevCancelledKey  — composite key of the departure we already fired cancelled for
 */
class TransportBoardDevice extends Homey.Device {
  async onInit() {
    this.log(`Device init: ${this.getName()} (stop=${this.getStopId()})`);

    // Per-departure state for smart flow triggers
    this._prevMins = null;
    this._prevDepartureKey = null;
    this._prevDelayMinutes = null;
    this._prevCancelledKey = null;

    // Register capability listener so user can toggle monitoring from the UI
    this.registerCapabilityListener('monitoring_enabled', async value => {
      this.log(`Monitoring toggled: ${value}`);
      if (value) {
        await this._startPolling();
      } else {
        this._stopPolling();
        await this.setCapabilityValue('api_status', 'Paused').catch(() => {});
      }
    });

    // Set initial capability values while waiting for first poll
    await this._setInitialCapabilities();

    const monitoringEnabled = this.getCapabilityValue('monitoring_enabled');
    if (monitoringEnabled !== false) {
      await this._startPolling();
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`Settings changed: ${changedKeys.join(', ')}`);
    // Any setting change invalidates current display data and restarts polling
    this._stopPolling();
    await this._startPolling();
  }

  async onDeleted() {
    this._stopPolling();
    this.log(`Device deleted: ${this.getName()}`);
  }

  // ---------------------------------------------------------------------------
  // Public API for flow action cards (called by driver.js run-listeners)
  // ---------------------------------------------------------------------------

  /** Force an immediate data refresh (used by the refresh_now action card). */
  async triggerRefresh() {
    await this._fetchAndUpdate();
  }

  // ---------------------------------------------------------------------------
  // Polling management
  // ---------------------------------------------------------------------------

  async _startPolling() {
    this._stopPolling();

    // Fetch immediately so the device shows data right away
    await this._fetchAndUpdate();

    const intervalMinutes = this.getSetting('pollingInterval') || 5;
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

    this._pollTimer = setInterval(() => {
      this._fetchAndUpdate().catch(err => {
        this.error(`Poll error: ${err.message}`);
      });
    }, intervalMs);

    this.log(`Polling started, interval=${intervalMinutes}min`);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Data fetch and update
  // ---------------------------------------------------------------------------

  async _fetchAndUpdate() {
    const stopId = this.getStopId();
    if (!stopId) {
      await this.setUnavailable('Stop ID not configured. Re-pair this device.');
      return;
    }

    const boardType = this.getSetting('boardType') || 'departures';
    const client = this.homey.app.getClient();

    let items;
    try {
      items = boardType === 'arrivals'
        ? await client.getArrivals(stopId)
        : await client.getDepartures(stopId);
    } catch (err) {
      await this._handleFetchError(err);
      return;
    }

    // Apply device-level filters (cancelled items are kept — we need them for detection)
    // Then sort by effective departure time so a bus delayed by hours doesn't
    // block an on-time bus that leaves in 6 minutes.
    const tz = this.homey.clock.getTimezone();
    const filtered = this._applyFilters(items)
      .filter(item => {
        // Drop items whose effective departure is more than 2 minutes in the past
        const mins = minutesUntil(effectiveIso(item), tz);
        return mins === null || mins > -2;
      })
      .sort((a, b) => {
        const mA = minutesUntil(effectiveIso(a), tz) ?? Infinity;
        const mB = minutesUntil(effectiveIso(b), tz) ?? Infinity;
        return mA - mB;
      });

    if (filtered.length === 0) {
      if (items.length > 0) {
        const sample = [...new Set(
          items.slice(0, 6).map(i => `${i.transportType}/${i.lineName || '?'}`),
        )].join(', ');
        await this._handleNoData(`No match. Available: ${sample}`);
      } else {
        await this._handleNoData('No departures found');
      }
      return;
    }

    // Ensure device is marked available (recovers from a previous error state)
    await this.setAvailable();

    // The first item is the next relevant departure/arrival (may be cancelled)
    const topItem = filtered[0];

    // Check for new cancellation before deciding what to display
    await this._checkCancellationState(topItem);

    // For display and most triggers, skip cancelled items
    const displayItems = filtered.filter(i => !i.isCancelled);

    if (displayItems.length === 0) {
      // Everything in the filtered list is cancelled
      const cancelMsg = topItem.isCancelled
        ? `Cancelled: ${topItem.lineName || topItem.lineDesignation || ''} → ${topItem.destination || topItem.origin || ''}`
        : 'All cancelled';
      await this._handleNoData(cancelMsg);
      return;
    }

    const next = displayItems[0];

    // Fix arrivals mode: show origin instead of destination
    const displayDestination = boardType === 'arrivals'
      ? (next.origin || next.destination || '')
      : (next.destination || '');

    // Determine the effective departure/arrival time for display
    const effectiveTime = next.realtimeAvailable ? next.realtimeTime : next.scheduledTime;
    const mins = minutesUntil(effectiveTime, this.homey.clock.getTimezone());

    const timeDisplay   = this._formatTime(effectiveTime);
    const delayDisplay  = next.delayMinutes !== 0
      ? `${timeDisplay} (${next.delayText})`
      : timeDisplay;

    // Update capabilities
    await Promise.all([
      this.setCapabilityValue('next_departure_time',      delayDisplay).catch(() => {}),
      this.setCapabilityValue('departure_line',           next.lineName || next.lineDesignation).catch(() => {}),
      this.setCapabilityValue('departure_destination',    displayDestination).catch(() => {}),
      this.setCapabilityValue('delay_minutes',            next.delayMinutes).catch(() => {}),
      this.setCapabilityValue('minutes_until_departure',  mins !== null ? mins : 0).catch(() => {}),
      this.setCapabilityValue('last_updated',             this._nowString()).catch(() => {}),
      this.setCapabilityValue('api_status',               'OK').catch(() => {}),
    ]);

    // --- Fire departure_updated (every successful poll) ---
    await this._fireTrigger('departure_updated', next, mins, boardType);

    // --- Per-departure state tracking for smart triggers ---
    const departureKey = `${next.journeyId || ''}-${next.scheduledTime || ''}`;

    if (departureKey !== this._prevDepartureKey) {
      // A different departure is now at the front of the display queue — reset state
      this._prevMins = null;
      this._prevDepartureKey = departureKey;
      this._prevDelayMinutes = null;
      this._prevCancelledKey = null;
    }

    // --- Fire departure_soon (once per departure, when countdown crosses threshold) ---
    if (mins !== null) {
      const prevMins = this._prevMins;   // null on first poll for this departure
      this._prevMins = mins;
      await this._fireSoonTrigger(next, mins, prevMins);
    }

    // --- Fire departure_delayed / departure_on_time ---
    const prevDelay = this._prevDelayMinutes;
    this._prevDelayMinutes = next.delayMinutes;

    if (next.delayMinutes > 0 && next.delayMinutes !== prevDelay) {
      // New or changed delay — fire departure_delayed
      await this._fireDelayedTrigger(next, mins);
    } else if (next.delayMinutes === 0 && prevDelay !== null && prevDelay > 0) {
      // Delay was present last poll, now cleared — fire departure_on_time
      await this._fireOnTimeTrigger(next, mins, boardType);
    }
  }

  // ---------------------------------------------------------------------------
  // Cancellation state tracking
  // ---------------------------------------------------------------------------

  /**
   * Check whether topItem (the first filtered item, possibly cancelled) is a
   * newly-cancelled departure that we haven't fired for yet.
   * Fires departure_cancelled if so, and records the key to avoid re-firing.
   */
  async _checkCancellationState(topItem) {
    if (!topItem.isCancelled) return;

    const cancelKey = `${topItem.journeyId || ''}-${topItem.scheduledTime || ''}`;
    if (cancelKey === this._prevCancelledKey) return;   // already fired for this one

    this._prevCancelledKey = cancelKey;
    await this._fireCancelledTrigger(topItem);
  }

  // ---------------------------------------------------------------------------
  // Flow triggers
  // ---------------------------------------------------------------------------

  /**
   * Build the standard token map shared by all departure triggers.
   * boardType is optional — only needed to pick the correct destination/origin label.
   */
  _buildTokens(item, minsUntil, boardType) {
    const bt = boardType || this.getSetting('boardType') || 'departures';
    const destinationToken = bt === 'arrivals'
      ? (item.origin || item.destination || '')
      : (item.destination || '');

    return {
      departure_time:           this._formatTime(item.realtimeAvailable ? item.realtimeTime : item.scheduledTime),
      scheduled_departure_time: this._formatTime(item.scheduledTime),
      realtime_departure_time:  item.realtimeAvailable ? this._formatTime(item.realtimeTime) : '',
      line_name:                item.lineName || item.lineDesignation || '',
      direction:                item.direction || '',
      destination:              destinationToken,
      transport_type:           item.transportType || '',
      platform:                 item.realtimePlatform || item.platform || '',
      delay_minutes:            item.delayMinutes,
      delay_text:               item.delayText || 'On time',
      is_cancelled:             item.isCancelled,
      realtime_available:       item.realtimeAvailable,
      minutes_until_departure:  minsUntil !== null ? minsUntil : 0,
      stop_name:                this.getStoredStopName(),
      operator:                 item.operator || '',
      origin:                   item.origin || '',
    };
  }

  /** Fire a named trigger with standard tokens (no state arg). */
  async _fireTrigger(triggerId, item, minsUntil, boardType) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard(triggerId);
      await trigger.trigger(this, this._buildTokens(item, minsUntil, boardType));
    } catch (err) {
      this.error(`Failed to fire ${triggerId}: ${err.message}`);
    }
  }

  /**
   * Fire departure_soon.
   * The run listener in driver.js receives state = { mins, prevMins } and
   * fires the flow only when the countdown crosses the user's threshold.
   */
  async _fireSoonTrigger(item, mins, prevMins) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('departure_soon');
      const state = { mins, prevMins };
      await trigger.trigger(this, this._buildTokens(item, mins), state);
    } catch (err) {
      this.error(`Failed to fire departure_soon: ${err.message}`);
    }
  }

  /**
   * Fire departure_delayed.
   * The run listener in driver.js receives state = { delayMinutes } and
   * fires only when the delay meets the user's minimum threshold.
   */
  async _fireDelayedTrigger(item, mins) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('departure_delayed');
      const state = { delayMinutes: item.delayMinutes };
      await trigger.trigger(this, this._buildTokens(item, mins), state);
    } catch (err) {
      this.error(`Failed to fire departure_delayed: ${err.message}`);
    }
  }

  /**
   * Fire departure_cancelled.
   * No configurable args — fires unconditionally for the newly-cancelled departure.
   * minsUntil is null here (the departure is cancelled), so we pass null → 0.
   */
  async _fireCancelledTrigger(item) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('departure_cancelled');
      await trigger.trigger(this, this._buildTokens(item, null));
    } catch (err) {
      this.error(`Failed to fire departure_cancelled: ${err.message}`);
    }
  }

  /**
   * Fire departure_on_time.
   * No configurable args — fires when a previously-delayed departure is now on time.
   */
  async _fireOnTimeTrigger(item, mins, boardType) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard('departure_on_time');
      await trigger.trigger(this, this._buildTokens(item, mins, boardType));
    } catch (err) {
      this.error(`Failed to fire departure_on_time: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  _applyFilters(items) {
    const transportType = (this.getSetting('transportTypeFilter') || 'ALL').toUpperCase();
    const lineFilter    = (this.getSetting('lineFilter') || '').trim().toUpperCase();
    const destFilter    = (this.getSetting('destinationFilter') || '').trim().toUpperCase();

    return items.filter(item => {
      // NOTE: cancelled items are kept so _checkCancellationState can detect them.
      // The display/trigger logic filters them out separately in _fetchAndUpdate.

      if (transportType !== 'ALL' && item.transportType !== transportType) return false;

      if (lineFilter) {
        const line = (item.lineName || item.lineDesignation || '').toUpperCase();
        if (!line.includes(lineFilter)) return false;
      }

      if (destFilter) {
        const dest = (item.destination || '').toUpperCase();
        if (!dest.includes(destFilter)) return false;
      }

      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  async _handleFetchError(err) {
    const isTyped = err instanceof TrafiklabError;
    const code = isTyped ? err.code : 'UNKNOWN';
    const msg = err.message || 'Unknown error';

    this.error(`Fetch error [${code}]: ${msg}`);

    let statusText;
    switch (code) {
      case 'MISSING_KEY':
      case 'INVALID_KEY':
        statusText = 'API key missing or invalid';
        await this.setUnavailable('Trafiklab API key is missing or invalid. Check App Settings.');
        break;
      case 'RATE_LIMIT':
        statusText = 'Rate limited';
        break;
      case 'NOT_FOUND':
        statusText = 'Stop not found';
        await this.setUnavailable('Stop not found. Re-pair this device.');
        break;
      case 'TIMEOUT':
        statusText = 'Request timeout';
        break;
      case 'NETWORK':
        statusText = 'Network error';
        break;
      default:
        statusText = `Error: ${msg.substring(0, 40)}`;
    }

    await Promise.all([
      this.setCapabilityValue('api_status',   statusText).catch(() => {}),
      this.setCapabilityValue('last_updated', this._nowString()).catch(() => {}),
    ]);
  }

  async _handleNoData(reason) {
    await this.setAvailable();
    await Promise.all([
      this.setCapabilityValue('next_departure_time',     'No departures').catch(() => {}),
      this.setCapabilityValue('departure_line',          '').catch(() => {}),
      this.setCapabilityValue('departure_destination',   '').catch(() => {}),
      this.setCapabilityValue('delay_minutes',           0).catch(() => {}),
      this.setCapabilityValue('minutes_until_departure', 0).catch(() => {}),
      this.setCapabilityValue('last_updated',            this._nowString()).catch(() => {}),
      this.setCapabilityValue('api_status',              reason || 'No data').catch(() => {}),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async _setInitialCapabilities() {
    await Promise.all([
      this.setCapabilityValue('next_departure_time',     '—').catch(() => {}),
      this.setCapabilityValue('departure_line',          '—').catch(() => {}),
      this.setCapabilityValue('departure_destination',   '—').catch(() => {}),
      this.setCapabilityValue('delay_minutes',           0).catch(() => {}),
      this.setCapabilityValue('minutes_until_departure', 0).catch(() => {}),
      this.setCapabilityValue('last_updated',            '—').catch(() => {}),
      this.setCapabilityValue('api_status',              'Starting…').catch(() => {}),
      this.setCapabilityValue('monitoring_enabled',      true).catch(() => {}),
    ]);
  }

  /** Format an ISO time string in Homey's configured timezone. */
  _formatTime(isoString) {
    return formatTime(isoString, this.homey.clock.getTimezone());
  }

  getStopId() {
    return this.getData().stopId || this.getData().id || this.getStoreValue('stopId') || '';
  }

  getStoredStopName() {
    return this.getStoreValue('stopName') || this.getName() || '';
  }

  _nowString() {
    try {
      const tz = this.homey.clock.getTimezone();
      const parts = new Intl.DateTimeFormat('en', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz,
      }).formatToParts(new Date());
      const h = parts.find(p => p.type === 'hour')?.value   || '00';
      const m = parts.find(p => p.type === 'minute')?.value || '00';
      const s = parts.find(p => p.type === 'second')?.value || '00';
      return `${h}:${m}:${s}`;
    } catch {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    }
  }
}

module.exports = TransportBoardDevice;
