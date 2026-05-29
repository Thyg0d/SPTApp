'use strict';

/**
 * Widget API — called by the departure-board widget HTML via Homey.api().
 *
 * GET /departure?deviceId=<id>
 *   Returns the current capability snapshot for the requested Transport Board device.
 */
module.exports = {
  async getDeparture({ homey, query }) {
    const { deviceId } = query;
    if (!deviceId) throw new Error('deviceId required');

    // Find the device — match on Homey's internal ID or our custom getData().id
    let device;
    try {
      const driver = homey.drivers.getDriver('transport-board');
      device = driver.getDevices().find(d =>
        d.id === deviceId || (d.getData && d.getData().id === deviceId),
      );
    } catch (err) {
      throw new Error('transport-board driver not available');
    }

    if (!device) throw new Error(`Device not found: ${deviceId}`);

    return {
      stopName:     device.getStoreValue('stopName') || device.getName(),
      line:         device.getCapabilityValue('departure_line')           ?? '',
      destination:  device.getCapabilityValue('departure_destination')    ?? '',
      nextDeparture: device.getCapabilityValue('next_departure_time')     ?? '—',
      minutesUntil:  device.getCapabilityValue('minutes_until_departure') ?? 0,
      delayMinutes:  device.getCapabilityValue('delay_minutes')           ?? 0,
      status:        device.getCapabilityValue('api_status')              ?? '',
      lastUpdated:   device.getCapabilityValue('last_updated')            ?? '',
    };
  },
};
