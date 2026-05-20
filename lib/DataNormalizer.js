'use strict';

/**
 * Normalizes raw Trafiklab Realtime API responses into stable internal models.
 *
 * This layer decouples flow cards, device capabilities, and app logic from
 * the raw API structure. If Trafiklab changes field names, only this file
 * needs updating.
 *
 * Internal models:
 *
 * Stop:
 *   id, name, transportTypes[], latitude, longitude, averageDailyDepartures
 *
 * BoardItem:
 *   id, type ('departure'|'arrival'), stopId, stopName,
 *   scheduledTime (ISO string), realtimeTime (ISO string|null),
 *   delaySeconds, delayMinutes, delayText,
 *   lineName, lineDesignation, direction, destination, origin,
 *   transportType (BUS|TRAIN|TRAM|METRO|FERRY|AIR|OTHER),
 *   transportModeCode,
 *   platform (scheduled), realtimePlatform,
 *   operator, journeyId, tripId,
 *   isCancelled, realtimeAvailable,
 *   disruptionMessage,
 *   raw (original API object, for debugging)
 */

/**
 * Safely extract a string from a value that may be a plain string or an object
 * with a name/text/description property (as some Trafiklab fields can be either).
 * @param {*} val
 * @returns {string}
 */
function _extractString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    return String(val.name || val.text || val.description || val.id || '');
  }
  return String(val);
}

/**
 * Parse the /stops/name/{query} response into an array of Stop objects.
 * @param {object} apiResponse  Raw API JSON
 * @returns {Stop[]}
 */
function normalizeStopGroups(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.stop_groups)) {
    return [];
  }

  return apiResponse.stop_groups.map(group => ({
    id: String(group.id || ''),
    name: String(group.name || ''),
    transportTypes: Array.isArray(group.transport_modes)
      ? group.transport_modes.map(m => String(m).toUpperCase())
      : [],
    // Individual stop positions within the group — useful for display detail
    positions: Array.isArray(group.stops)
      ? group.stops.map(s => ({
          id: String(s.id || ''),
          name: String(s.name || ''),
          latitude: typeof s.lat === 'number' ? s.lat : parseFloat(s.lat) || 0,
          longitude: typeof s.lon === 'number' ? s.lon : parseFloat(s.lon) || 0,
        }))
      : [],
    // Approximate importance — higher means bigger/busier stop
    averageDailyDepartures: typeof group.average_daily_stop_times === 'number'
      ? group.average_daily_stop_times
      : 0,
  }));
}

/**
 * Parse the /departures/{areaId} or /arrivals/{areaId} response.
 * @param {object} apiResponse  Raw API JSON
 * @param {'departure'|'arrival'} type
 * @returns {BoardItem[]}
 */
function normalizeBoardItems(apiResponse, type) {
  const key = type === 'arrival' ? 'arrivals' : 'departures';
  const items = apiResponse && Array.isArray(apiResponse[key]) ? apiResponse[key] : [];

  return items.map((item, index) => {
    const scheduledTime = item.scheduled || null;
    const realtimeTime = item.realtime || null;
    const isRealtime = Boolean(item.is_realtime);

    // delay field is in minutes (integer) per Trafiklab spec
    const delayMinutes = typeof item.delay === 'number' ? item.delay : 0;
    const delaySeconds = delayMinutes * 60;

    const route = item.route || {};
    const agency = item.agency || {};
    const stop = item.stop || {};

    // Alerts: pick the first message if present
    const alerts = Array.isArray(item.alerts) ? item.alerts : [];
    const disruptionMessage = alerts.length > 0
      ? String(alerts[0].message || alerts[0].text || '')
      : '';

    return {
      // Use trip + stop ID + scheduled time as a stable composite ID
      id: `${item.trip || index}-${stop.id || ''}-${scheduledTime || index}`,
      type,

      stopId: String(stop.id || ''),
      stopName: String(stop.name || ''),

      scheduledTime,
      realtimeTime: isRealtime ? realtimeTime : null,

      delaySeconds,
      delayMinutes,
      delayText: formatDelayText(delayMinutes),

      // designation is the human-visible line number ("35", "40X", "Pendeltåg").
      // name is often the operator abbreviation ("SL") — use it only as fallback.
      lineName: String(route.designation || route.line_designation || route.line || route.name || ''),
      lineDesignation: String(route.designation || route.line_designation || route.line || route.name || ''),
      direction: String(route.direction || ''),
      // destination may arrive as a plain string OR as an object {name, id}
      destination: _extractString(route.destination),
      origin: _extractString(route.origin),

      transportType: normalizeTransportMode(route.transport_mode),
      transportModeCode: typeof route.transport_mode_code === 'number'
        ? route.transport_mode_code
        : null,

      platform: item.scheduled_platform ? String(item.scheduled_platform) : '',
      realtimePlatform: item.realtime_platform ? String(item.realtime_platform) : '',

      operator: String(agency.name || ''),
      journeyId: String(item.journey_id || item.trip || ''),
      tripId: String(item.trip || ''),

      isCancelled: Boolean(item.canceled),
      realtimeAvailable: isRealtime,

      disruptionMessage,
      raw: item,
    };
  });
}

/**
 * Normalise transport mode strings to a consistent uppercase enum.
 * The Trafiklab API uses strings like "BUS", "TRAIN", "TRAM", "METRO",
 * "FERRY", "AIR". Map any unexpected values to "OTHER".
 */
function normalizeTransportMode(mode) {
  if (!mode) return 'OTHER';
  const upper = String(mode).toUpperCase();
  const KNOWN = new Set(['BUS', 'TRAIN', 'TRAM', 'METRO', 'FERRY', 'AIR']);
  return KNOWN.has(upper) ? upper : 'OTHER';
}

/**
 * Format delay as a human-readable string for display in flows.
 * @param {number} minutes  Can be negative (early arrival)
 * @returns {string}
 */
function formatDelayText(minutes) {
  if (minutes === 0) return 'On time';
  if (minutes > 0) return `+${minutes} min late`;
  return `${Math.abs(minutes)} min early`;
}

/**
 * Returns true if the ISO string has an explicit timezone indicator
 * (trailing Z, or ±HH:MM / ±HHMM offset).
 * @param {string} s
 * @returns {boolean}
 */
function _hasTimezone(s) {
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s);
}

/**
 * Parse a naive (no-timezone) ISO datetime string as a wall-clock time in
 * the given IANA timezone and return the equivalent UTC milliseconds.
 *
 * Algorithm:
 *  1. Append 'Z' so JS parses the digits as UTC (same wall-clock value).
 *  2. Ask Intl what the target timezone says that UTC moment is.
 *  3. The difference between that Intl representation and the UTC moment
 *     is the UTC offset at that time (handles DST automatically).
 *  4. Subtract the offset to get the true UTC ms for the local wall-clock time.
 *
 * @param {string} naiveIso  e.g. "2026-05-18T13:24:00"
 * @param {string} timezone  e.g. "Europe/Stockholm"
 * @returns {number} UTC milliseconds
 */
function _naiveLocalToUtcMs(naiveIso, timezone) {
  const asUtc = new Date(naiveIso + 'Z');
  const parts = new Intl.DateTimeFormat('en', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: timezone,
  }).formatToParts(asUtc);
  const get  = type => (parts.find(p => p.type === type) || { value: '00' }).value;
  const tzMs = new Date(
    `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`,
  ).getTime();
  // offsetMs > 0 for UTC+ zones (e.g. +7 200 000 for UTC+2)
  const offsetMs = tzMs - asUtc.getTime();
  return asUtc.getTime() - offsetMs;
}

/**
 * Format an ISO 8601 datetime string as HH:MM.
 *
 * • Naive strings (no Z / offset) — assumed already in local time; HH:MM
 *   is extracted directly from the string. No conversion applied.
 * • Strings with an explicit timezone (Z or ±offset) — converted to the
 *   given IANA timezone using Intl before extracting HH:MM.
 *
 * @param {string|null} isoString
 * @param {string}      [timezone]  IANA tz, e.g. "Europe/Stockholm"
 * @returns {string}  "HH:MM" or ""
 */
function formatTime(isoString, timezone) {
  if (!isoString) return '';
  try {
    if (_hasTimezone(isoString) && timezone) {
      // UTC / offset timestamp → convert to local timezone
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return '';
      const parts = new Intl.DateTimeFormat('en', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
      }).formatToParts(d);
      return `${parts.find(p => p.type === 'hour')?.value   || '00'}`
           + `:${parts.find(p => p.type === 'minute')?.value || '00'}`;
    }
    // Naive local timestamp — extract HH:MM directly (already correct local time)
    const m = isoString.match(/T(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
  } catch {
    return '';
  }
}

/**
 * Calculate minutes until a given ISO 8601 datetime from now.
 *
 * Pass the Homey timezone so naive API timestamps (no Z / offset) are
 * interpreted as local wall-clock time rather than UTC.
 *
 * @param {string|null} isoString
 * @param {string}      [timezone]  IANA tz, e.g. "Europe/Stockholm"
 * @returns {number|null}
 */
function minutesUntil(isoString, timezone) {
  if (!isoString) return null;
  try {
    let ms;
    if (_hasTimezone(isoString)) {
      ms = new Date(isoString).getTime();        // has explicit tz → parse directly
    } else if (timezone) {
      ms = _naiveLocalToUtcMs(isoString, timezone); // naive → convert via tz
    } else {
      ms = new Date(isoString).getTime();        // no tz info → best effort
    }
    if (isNaN(ms)) return null;
    return Math.round((ms - Date.now()) / 60000);
  } catch {
    return null;
  }
}

module.exports = {
  normalizeStopGroups,
  normalizeBoardItems,
  normalizeTransportMode,
  formatDelayText,
  formatTime,
  minutesUntil,
};
