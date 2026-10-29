'use strict';

const { HomeyAPI } = require('homey-api');

/**
 * Widget API — called by the departure-board widget HTML via Homey.api().
 *
 * GET /departures?deviceIds=<id1,id2,...>
 *   Returns a capability snapshot for each requested Transport Board device,
 *   in the same order as requested. One failing device does not fail the rest.
 *
 * Why the Web API:
 *   The widget frontend selects devices via the top-level `devices` setting and
 *   reads their IDs with Homey.getDeviceIds(). Those are Homey's *manager* device
 *   UUIDs (e.g. "a2a793ad-…"), which are NOT exposed on app-side Device instances
 *   (driver.getDevices()[n].id is undefined) and never match our getData().id.
 *   The only component that knows the UUID↔device mapping is the Homey Web API,
 *   so we resolve devices through it (requires the "homey:manager:api" permission)
 *   and read live values from device.capabilitiesObj.
 */

// Cache the API instance across polls (the widget refetches every 30s).
let _apiPromise = null;
function getApi(homey) {
  if (!_apiPromise) {
    _apiPromise = HomeyAPI.createAppAPI({ homey });
  }
  return _apiPromise;
}

function snapshot(device) {
  const caps = device.capabilitiesObj || {};
  const store = device.store || {};
  const val = (id, fallback) =>
    (caps[id] && caps[id].value != null ? caps[id].value : fallback);

  // Preferred source: the multi-departure list the device writes each poll.
  // Rows carry { line, destination, time, ts, delay }; ts is an absolute UTC
  // timestamp the widget uses to tick the countdown down live.
  let upcoming = Array.isArray(store.upcoming) ? store.upcoming : [];

  // Fallback for devices that haven't written the list yet (e.g. just after an
  // app update, before their first poll): synthesise a single row from the live
  // capabilities so the widget still shows the next departure. ts is null here,
  // so the widget shows the server-provided minutes/time without live ticking.
  if (!upcoming.length) {
    const line = val('departure_line', '');
    const time = val('next_departure_time', '');
    const hasDeparture = (line && line !== '—')
      || (time && time !== '—' && time !== 'No departures');
    if (hasDeparture) {
      upcoming = [{
        line,
        destination: val('departure_destination', ''),
        time,
        ts: null,
        minutes: val('minutes_until_departure', null),
        delay: val('delay_minutes', 0),
      }];
    }
  }

  return {
    stopName:    store.stopName || device.name || '—',
    upcoming,
    status:      val('api_status', ''),
    lastUpdated: val('last_updated', ''),
  };
}

module.exports = {
  async getDepartures({ homey, query }) {
    const raw = (query && (query.deviceIds || query.deviceId)) || '';
    const ids = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error('deviceIds required');

    const api = await getApi(homey);

    const boards = [];
    for (const id of ids) {
      try {
        const device = await api.devices.getDevice({ id });
        if (!device) throw new Error('not found');
        boards.push(snapshot(device));
      } catch (err) {
        boards.push({ error: true, stopName: 'Board unavailable', status: '' });
      }
    }
    return boards;
  },
};
