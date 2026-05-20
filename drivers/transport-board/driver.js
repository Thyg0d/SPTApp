'use strict';

const Homey = require('homey');

/**
 * TransportBoardDriver — handles pairing and driver-level lifecycle.
 *
 * Flow card run-listeners are registered here (once per driver, not once per
 * device) so they are never duplicated when multiple devices exist.
 *
 * Trigger run-listeners decide whether a specific flow instance fires:
 *   departure_soon    — (args, state) => countdown just crossed args.minutes
 *   departure_delayed — (args, state) => delay >= args.min_delay_minutes
 *
 * Condition run-listeners (getConditionCard) read live capability values from args.device:
 *   is_delayed        — delay_minutes > 0
 *   is_within_minutes — minutes_until_departure <= args.minutes
 *
 * Action run-listeners (getActionCard) call public methods on args.device:
 *   refresh_now       — args.device.triggerRefresh()
 */
class TransportBoardDriver extends Homey.Driver {
  async onInit() {
    this.log('TransportBoardDriver initialised');
    this._registerFlowListeners();
  }

  async onPairListDevices() {
    const savedStops = this.homey.settings.get('savedStops') || [];

    if (!Array.isArray(savedStops) || savedStops.length === 0) {
      throw new Error(
        'No stops saved yet.\n\n'
        + 'Go to Apps → Trafiklab Departures → Settings, '
        + 'search for your stop, and click "Save Stop". '
        + 'Then come back here to add a device.',
      );
    }

    return savedStops.map(stop => ({
      name: stop.name,
      data: { id: stop.id },
    }));
  }

  // ---------------------------------------------------------------------------
  // Flow card listeners
  // ---------------------------------------------------------------------------

  _registerFlowListeners() {
    // --- Trigger: departure_soon ---
    // Fires once when the countdown crosses the user's threshold.
    // state.prevMins is the countdown from the previous poll (null = first poll).
    // state.mins    is the countdown right now.
    // We fire when the value transitions from above the threshold to at-or-below.
    this.homey.flow
      .getDeviceTriggerCard('departure_soon')
      .registerRunListener((args, state) => {
        const prev = state.prevMins !== null ? state.prevMins : Infinity;
        return prev > args.minutes && state.mins <= args.minutes;
      });

    // --- Trigger: departure_delayed ---
    // Fires when a new/changed delay is detected.
    // state.delayMinutes is the current delay for the departure that changed.
    this.homey.flow
      .getDeviceTriggerCard('departure_delayed')
      .registerRunListener((args, state) => {
        return state.delayMinutes >= args.min_delay_minutes;
      });

    // --- Condition: is_delayed ---
    this.homey.flow
      .getConditionCard('is_delayed')
      .registerRunListener((args) => {
        return (args.device.getCapabilityValue('delay_minutes') || 0) > 0;
      });

    // --- Condition: is_within_minutes ---
    this.homey.flow
      .getConditionCard('is_within_minutes')
      .registerRunListener((args) => {
        const mins = args.device.getCapabilityValue('minutes_until_departure') || 0;
        return mins >= 0 && mins <= args.minutes;
      });

    // --- Action: refresh_now ---
    this.homey.flow
      .getActionCard('refresh_now')
      .registerRunListener(async (args) => {
        await args.device.triggerRefresh();
      });

    this.log('Flow listeners registered');
  }
}

module.exports = TransportBoardDriver;
