import { describe, expect, it } from 'vitest';

import type { ApplyResult, ScanEvent } from '../types/events.js';
import {
  DEBOUNCE_WINDOW_MS,
  applyScan,
  createRouteRunState,
  directionContradictions,
  directionOf,
  directionSourceOf,
  isAboard,
  restoreRouteRunState,
  toManifest,
  type RosterLookup,
  type RouteRunState,
} from './stateMachine.js';
import { closeRouteRun, reconcileRouteRun } from './reconcile.js';
import {
  BUS_12,
  BUS_ROGUE,
  ROUTE_RUN,
  cardId,
  rosterOf,
  scan,
  student,
  studentId,
  t,
  unmatchedScan,
  userId,
} from './testFixtures.js';

const ADA = student('stu-ada', 'user-ada-0001');
const BEN = student('stu-ben', 'user-ben-0002');
/** Assigned to BUS_ROGUE, so boarding BUS_12 is a wrong-bus boarding (D-005). */
const CAI = student('stu-cai', 'user-cai-0003', BUS_ROGUE);

const roster = rosterOf(ADA, BEN, CAI);

function newRun(): RouteRunState {
  return createRouteRunState({ busId: BUS_12, routeRunId: ROUTE_RUN, startedAt: t('07:50:00') });
}

/** Feed events in arrival order, threading state. */
function feed(
  events: readonly ScanEvent[],
  lookup: RosterLookup = roster,
  initial: RouteRunState = newRun(),
): { state: RouteRunState; results: ApplyResult[] } {
  let state = initial;
  const results: ApplyResult[] = [];
  for (const event of events) {
    const outcome = applyScan(state, event, { lookupUser: lookup });
    state = outcome.state;
    results.push(outcome.result);
  }
  return { state, results };
}

describe('applyScan — derived direction (D-002 fallback path)', () => {
  it('derives on for a student not aboard and off for one already aboard', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:30:00')),
    ]);

    expect(results[0]).toMatchObject({ applied: true, alerts: [] });
    expect(results[0]?.scan).toMatchObject({
      studentId: ADA.studentId,
      direction: 'on',
      directionSource: 'derived',
    });
    expect(results[1]?.scan).toMatchObject({ direction: 'off', directionSource: 'derived' });
    expect(state.aboard).toEqual([]);
    expect(isAboard(state, ADA.studentId)).toBe(false);
  });

  it('marks the log entries as derived and free of contradictions', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-off' }),
    ]);

    expect(directionSourceOf(state, 'evt-on')).toBe('derived');
    expect(directionSourceOf(state, 'evt-off')).toBe('derived');
    expect(directionContradictions(state)).toEqual([]);
  });

  it('puts the student on the manifest with boarding provenance', () => {
    const { state } = feed([scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-a1' })]);

    expect(state.aboard).toEqual([
      {
        studentId: ADA.studentId,
        boardedAt: t('08:00:00'),
        boardingEventId: 'evt-a1',
        wrongBus: false,
      },
    ]);
    expect(toManifest(state)).toEqual({
      busId: BUS_12,
      routeRunId: ROUTE_RUN,
      aboard: state.aboard,
      updatedAt: t('08:00:00'),
    });
  });

  it('never invents a clipRef on the manifest — the webhook carries none (D-008)', () => {
    const { state } = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);

    expect(state.aboard[0]).not.toHaveProperty('clipRef');
  });

  it('preserves the raw event fields on the ResolvedScan', () => {
    const event = scan(ADA.verkadaUserId, t('08:00:00'), { cardId: cardId('109|35302') });
    const { result } = applyScan(newRun(), event, { lookupUser: roster });

    expect(result.scan).toEqual({
      ...event,
      studentId: ADA.studentId,
      direction: 'on',
      directionSource: 'derived',
    });
  });

  it('carries the audit-only cardId onto the log without keying off it', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-1', cardId: cardId('109|35302') }),
      // Same student, a different raw input_value (NFC reports a binary string).
      scan(ADA.verkadaUserId, t('08:30:00'), {
        eventId: 'evt-2',
        cardId: cardId('0110100101010101010101010101010101010101'),
      }),
    ]);

    expect(state.log.map((entry) => entry.studentId)).toEqual([ADA.studentId, ADA.studentId]);
    expect(state.log.map((entry) => entry.direction)).toEqual(['on', 'off']);
    expect(state.log[0]?.cardId).toBe(cardId('109|35302'));
  });

  it('tracks students independently', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(BEN.verkadaUserId, t('08:05:00')),
      scan(ADA.verkadaUserId, t('08:20:00')),
    ]);

    expect(state.aboard.map((entry) => entry.studentId)).toEqual([BEN.studentId]);
  });

  it('debounces per student, not per bus — two students boarding back to back both board', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(BEN.verkadaUserId, t('08:00:01')),
    ]);

    expect(results.every((r) => r.applied)).toBe(true);
    expect(state.aboard).toHaveLength(2);
  });
});

describe('applyScan — device-reported direction (revised D-002)', () => {
  it('boards on a reported Inbound and marks the source as device', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in', direction: 'Inbound' }),
    ]);

    expect(results[0]?.scan).toMatchObject({ direction: 'on', directionSource: 'device' });
    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(directionSourceOf(state, 'evt-in')).toBe('device');
  });

  it('exits on a reported Outbound', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { direction: 'Outbound' }),
    ]);

    expect(results[1]?.scan).toMatchObject({ direction: 'off', directionSource: 'device' });
    expect(isAboard(state, ADA.studentId)).toBe(false);
    expect(directionContradictions(state)).toEqual([]);
  });

  it('does not debounce the reported path — a second Inbound is still a boarding', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in-1', direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:00:03'), { eventId: 'evt-in-2', direction: 'Inbound' }),
    ]);

    expect(results.map((r) => r.applied)).toEqual([true, true]);
    expect(results[1]?.scan?.direction).toBe('on');
    expect(isAboard(state, ADA.studentId)).toBe(true);
    // The later boarding is the one on the manifest.
    expect(state.aboard[0]?.boardingEventId).toBe('evt-in-2');
  });

  it('honours a reported Outbound three seconds after a reported Inbound', () => {
    // Derived mode would call this a double-tap and suppress it. The door says
    // the student walked back out, so they did.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:00:03'), { direction: 'Outbound' }),
    ]);

    expect(results[1]).toMatchObject({ applied: true });
    expect(results[1]?.scan?.direction).toBe('off');
    expect(isAboard(state, ADA.studentId)).toBe(false);
  });

  it('still flags a wrong-bus boarding when the direction was reported (D-005)', () => {
    const { state, results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00'), { eventId: 'evt-w', direction: 'Inbound' }),
    ]);

    expect(results[0]?.alerts.map((alert) => alert.kind)).toEqual(['wrong_bus']);
    expect(state.aboard[0]?.wrongBus).toBe(true);
  });

  it('keeps the reported direction stable across a replay triggered by a late event', () => {
    // A late-arriving earlier event re-derives everything; a device-reported
    // direction must come out of the replay unchanged.
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-out', direction: 'Outbound' }),
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in', direction: 'Inbound' }),
    ]);

    expect(directionOf(state, 'evt-in')).toBe('on');
    expect(directionOf(state, 'evt-out')).toBe('off');
    expect(isAboard(state, ADA.studentId)).toBe(false);
  });
});

describe('applyScan — reported direction contradicting derivation', () => {
  it('lets the report win when it says Inbound for a student already aboard', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-1', direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:20:00'), { eventId: 'evt-2', direction: 'Inbound' }),
    ]);

    // Derivation would have said 'off'. It does not get a vote.
    expect(results[1]?.scan?.direction).toBe('on');
    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(directionContradictions(state).map((entry) => entry.eventId)).toEqual(['evt-2']);
  });

  it('lets the report win when it says Outbound for a student never seen boarding', () => {
    // A missed boarding tap, or a student who was aboard before the run opened.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-out', direction: 'Outbound' }),
    ]);

    expect(results[0]?.applied).toBe(true);
    expect(results[0]?.scan?.direction).toBe('off');
    expect(isAboard(state, ADA.studentId)).toBe(false);
    expect(directionContradictions(state).map((entry) => entry.eventId)).toEqual(['evt-out']);
  });

  it('records the contradiction on the log entry rather than raising an alert', () => {
    // The contract has no AlertKind for this; it is state the portal reads.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-out', direction: 'Outbound' }),
    ]);

    expect(results[0]?.alerts).toEqual([]);
    expect(state.log[0]).toMatchObject({
      eventId: 'evt-out',
      directionSource: 'device',
      contradictsDerived: true,
      reportedDirection: 'Outbound',
    });
  });

  it('reports no contradiction when the device and derivation agree', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { direction: 'Outbound' }),
      scan(ADA.verkadaUserId, t('08:40:00'), { direction: 'Inbound' }),
    ]);

    expect(directionContradictions(state)).toEqual([]);
  });

  it('never marks a derived scan as contradicting — derivation cannot disagree with itself', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:30:00')),
      scan(ADA.verkadaUserId, t('08:40:00')),
    ]);

    expect(state.log.every((entry) => entry.contradictsDerived === false)).toBe(true);
  });

  it('re-evaluates the contradiction when a late event changes what derivation would say', () => {
    // The reported Outbound arrives alone and contradicts (nobody aboard). The
    // boarding then lands late and the contradiction disappears.
    const first = feed([
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-out', direction: 'Outbound' }),
    ]);
    expect(directionContradictions(first.state)).toHaveLength(1);

    const { state } = feed(
      [scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on' })],
      roster,
      first.state,
    );

    expect(directionContradictions(state)).toEqual([]);
  });
});

describe('applyScan — mixed reported and derived within one run', () => {
  it('derives from a projection that a device-reported tap established', () => {
    // Front door is an In/Out Door, rear door is not — or the door was
    // reconfigured mid-run. Either way the two paths compose.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in', direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-plain' }),
    ]);

    expect(results[1]?.scan).toMatchObject({ direction: 'off', directionSource: 'derived' });
    expect(directionSourceOf(state, 'evt-in')).toBe('device');
    expect(directionSourceOf(state, 'evt-plain')).toBe('derived');
    expect(isAboard(state, ADA.studentId)).toBe(false);
  });

  it('accepts a reported exit for a boarding that was derived', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-plain' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-out', direction: 'Outbound' }),
    ]);

    expect(results[0]?.scan?.directionSource).toBe('derived');
    expect(results[1]?.scan?.directionSource).toBe('device');
    expect(isAboard(state, ADA.studentId)).toBe(false);
    expect(directionContradictions(state)).toEqual([]);
  });

  it('debounces a derived tap that follows a reported tap inside the window', () => {
    // The device tap advances the debounce clock, so the unreported tap three
    // seconds later is the same physical tap and must not read as an exit.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in', direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:00:03'), { eventId: 'evt-plain' }),
    ]);

    expect(results[1]).toEqual({ applied: false, reason: 'debounced', alerts: [] });
    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(directionOf(state, 'evt-plain')).toBeNull();
  });

  it('handles two students on one run, one reported and one derived', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(BEN.verkadaUserId, t('08:01:00')),
      scan(BEN.verkadaUserId, t('08:31:00')),
    ]);

    expect(state.aboard.map((entry) => entry.studentId)).toEqual([ADA.studentId]);
  });

  it('lands a mixed run identically whatever the delivery order', () => {
    const events = [
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-1', direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-2' }),
      scan(BEN.verkadaUserId, t('08:10:00'), { eventId: 'evt-3' }),
      scan(ADA.verkadaUserId, t('08:40:00'), { eventId: 'evt-4', direction: 'Inbound' }),
    ];
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];

    const projections = orders.map((order) => {
      const { state } = feed(order.map((index) => events[index] as ScanEvent));
      return [...state.log]
        .map((entry) => `${entry.eventId}:${entry.direction}:${entry.directionSource}`)
        .sort();
    });

    for (const projection of projections) {
      expect(projection).toEqual(projections[0]);
    }
    expect(projections[0]).toEqual([
      'evt-1:on:device',
      'evt-2:off:derived',
      'evt-3:on:derived',
      'evt-4:on:device',
    ]);
  });
});

describe('applyScan — rejected credentials never board (D-009)', () => {
  it('returns credential_rejected and leaves state untouched', () => {
    const before = newRun();
    const outcome = applyScan(
      before,
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-rej', accepted: false }),
      { lookupUser: roster },
    );

    expect(outcome.result).toEqual({
      applied: false,
      reason: 'credential_rejected',
      alerts: [],
    });
    expect(outcome.state).toBe(before);
    expect(outcome.state.log).toEqual([]);
    expect(isAboard(outcome.state, ADA.studentId)).toBe(false);
  });

  it('does not board even when the door reports Inbound', () => {
    // The card did not open the door. A reported direction does not make a
    // refused tap into a validated boarding.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { accepted: false, direction: 'Inbound' }),
    ]);

    expect(results[0]?.reason).toBe('credential_rejected');
    expect(isAboard(state, ADA.studentId)).toBe(false);
    expect(state.log).toEqual([]);
  });

  it('does not scan a boarded student off', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-rej', accepted: false }),
    ]);

    expect(results[1]?.reason).toBe('credential_rejected');
    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(state.log).toHaveLength(1);
  });

  it('raises no wrong-bus alert for a rejected tap on the wrong bus', () => {
    const { state, results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00'), { accepted: false }),
    ]);

    expect(results[0]?.alerts).toEqual([]);
    expect(state.wrongBusAlerted).toEqual([]);
  });

  it('stays credential_rejected on redelivery rather than becoming a duplicate', () => {
    const event = scan(ADA.verkadaUserId, t('08:00:00'), {
      eventId: 'evt-rej',
      accepted: false,
    });
    const { results } = feed([event, event]);

    expect(results.map((r) => r.reason)).toEqual(['credential_rejected', 'credential_rejected']);
  });

  it('does not block the accepted retry that follows it', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-rej', accepted: false }),
      scan(ADA.verkadaUserId, t('08:00:04'), { eventId: 'evt-ok' }),
    ]);

    // The refused tap never entered the log, so it cannot debounce the retry.
    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(directionOf(state, 'evt-ok')).toBe('on');
  });
});

describe('applyScan — double-tap debounce on the derived path (D-002)', () => {
  it('ignores a second tap inside the window instead of reading it as an exit', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-first' }),
      scan(ADA.verkadaUserId, t('08:00:03'), { eventId: 'evt-second' }),
    ]);

    expect(results[1]).toEqual({ applied: false, reason: 'debounced', alerts: [] });
    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(directionOf(state, 'evt-first')).toBe('on');
    expect(directionOf(state, 'evt-second')).toBeNull();
  });

  it('keeps the debounced tap in the log so it is not re-applied later', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-first' }),
      scan(ADA.verkadaUserId, t('08:00:03'), { eventId: 'evt-second' }),
    ]);

    expect(state.log).toHaveLength(2);

    const replay = applyScan(
      state,
      scan(ADA.verkadaUserId, t('08:00:03'), { eventId: 'evt-second' }),
      { lookupUser: roster },
    );
    expect(replay.result).toEqual({ applied: false, reason: 'duplicate_event', alerts: [] });
    expect(replay.state.log).toHaveLength(2);
  });

  it('distinguishes a double-tap from a redelivered eventId', () => {
    const first = applyScan(newRun(), scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-a' }), {
      lookupUser: roster,
    });
    const doubleTap = applyScan(
      first.state,
      scan(ADA.verkadaUserId, t('08:00:02'), { eventId: 'evt-b' }),
      { lookupUser: roster },
    );
    const redelivery = applyScan(
      doubleTap.state,
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-a' }),
      { lookupUser: roster },
    );

    expect(doubleTap.result.reason).toBe('debounced');
    expect(redelivery.result.reason).toBe('duplicate_event');
  });

  it('suppresses a burst of taps rather than toggling the student on and off', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:00:01')),
      scan(ADA.verkadaUserId, t('08:00:02')),
      scan(ADA.verkadaUserId, t('08:00:04')),
    ]);

    expect(isAboard(state, ADA.studentId)).toBe(true);
    expect(state.log.filter((entry) => entry.direction !== null)).toHaveLength(1);
  });

  it('measures the window from the last accepted tap, not the last suppressed one', () => {
    // 08:00:00 accepted, 08:00:10 suppressed, 08:00:16 is 16s after the accepted
    // tap so it is a genuine exit even though it is 6s after the suppressed one.
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:00:10')),
      scan(ADA.verkadaUserId, t('08:00:16')),
    ]);

    expect(isAboard(state, ADA.studentId)).toBe(false);
  });

  it('accepts a tap exactly at the window boundary', () => {
    const boundary = new Date(Date.parse(t('08:00:00')) + DEBOUNCE_WINDOW_MS).toISOString();
    const { results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, boundary),
    ]);

    expect(results[1]?.scan?.direction).toBe('off');
  });

  it('suppresses a tap one millisecond inside the window boundary', () => {
    const inside = new Date(Date.parse(t('08:00:00')) + DEBOUNCE_WINDOW_MS - 1).toISOString();
    const { results, state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, inside),
    ]);

    expect(results[1]?.applied).toBe(false);
    expect(isAboard(state, ADA.studentId)).toBe(true);
  });

  it('honours an overridden debounce window', () => {
    const state = newRun();
    const first = applyScan(state, scan(ADA.verkadaUserId, t('08:00:00')), {
      lookupUser: roster,
      debounceWindowMs: 1_000,
    });
    const second = applyScan(first.state, scan(ADA.verkadaUserId, t('08:00:03')), {
      lookupUser: roster,
      debounceWindowMs: 1_000,
    });

    expect(second.result.scan?.direction).toBe('off');
  });

  it('does not apply the debounce window to reported directions at any width', () => {
    const state = newRun();
    const first = applyScan(
      state,
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-1', direction: 'Inbound' }),
      { lookupUser: roster, debounceWindowMs: 3_600_000 },
    );
    const second = applyScan(
      first.state,
      scan(ADA.verkadaUserId, t('08:00:01'), { eventId: 'evt-2', direction: 'Outbound' }),
      { lookupUser: roster, debounceWindowMs: 3_600_000 },
    );

    expect(second.result.applied).toBe(true);
    expect(second.result.scan?.direction).toBe('off');
  });
});

describe('applyScan — idempotency', () => {
  it('is a no-op the second time the same eventId is applied', () => {
    const event = scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-dup' });
    const first = applyScan(newRun(), event, { lookupUser: roster });
    const second = applyScan(first.state, event, { lookupUser: roster });

    expect(second.result).toEqual({ applied: false, reason: 'duplicate_event', alerts: [] });
    expect(second.state).toBe(first.state);
  });

  it('rejects a redelivery long after the debounce window has passed', () => {
    const event = scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-dup' });
    const first = applyScan(newRun(), event, { lookupUser: roster });
    const redelivered: ScanEvent = { ...event, receivedAt: t('09:00:00') };
    const second = applyScan(first.state, redelivered, { lookupUser: roster });

    expect(second.result.reason).toBe('duplicate_event');
    expect(isAboard(second.state, ADA.studentId)).toBe(true);
    expect(second.state.log).toHaveLength(1);
  });

  it('rejects a redelivery of a device-reported tap without re-boarding', () => {
    const event = scan(ADA.verkadaUserId, t('08:00:00'), {
      eventId: 'evt-dup-in',
      direction: 'Inbound',
    });
    const first = applyScan(newRun(), event, { lookupUser: roster });
    const second = applyScan(first.state, event, { lookupUser: roster });

    expect(second.result.reason).toBe('duplicate_event');
    expect(second.state.log).toHaveLength(1);
  });

  it('does not raise the wrong-bus alert twice for a redelivered boarding', () => {
    const event = scan(CAI.verkadaUserId, t('08:00:00'), { eventId: 'evt-wrong' });
    const first = applyScan(newRun(), event, { lookupUser: roster });
    const second = applyScan(first.state, event, { lookupUser: roster });

    expect(first.result.alerts).toHaveLength(1);
    expect(second.result.alerts).toEqual([]);
  });

  it('treats identical taps with different eventIds as a double-tap, not a duplicate id', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-a' }),
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-b' }),
    ]);

    expect(state.log).toHaveLength(2);
    expect(isAboard(state, ADA.studentId)).toBe(true);
  });
});

describe('applyScan — out-of-order arrival (D-003)', () => {
  it('orders on occurredAt, so an exit delivered first does not board the student', () => {
    // The 08:30 exit arrives before the 08:00 boarding — the classic buffered
    // cellular delivery. Naive incremental logic would leave Ada aboard forever.
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-exit', receivedAt: t('08:31:00') }),
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-board', receivedAt: t('08:31:05') }),
    ]);

    expect(results[0]?.scan?.direction).toBe('on'); // best guess at the time
    expect(directionOf(state, 'evt-board')).toBe('on'); // corrected by replay
    expect(directionOf(state, 'evt-exit')).toBe('off');
    expect(state.aboard).toEqual([]);
  });

  it('reports the corrected direction for the late event itself', () => {
    const { results } = feed([
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-exit' }),
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-board' }),
    ]);

    expect(results[1]?.scan?.direction).toBe('on');
  });

  it('produces the same final state for every arrival order of the same events', () => {
    const events = [
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-1' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-2' }),
      scan(BEN.verkadaUserId, t('08:10:00'), { eventId: 'evt-3' }),
      scan(ADA.verkadaUserId, t('08:40:00'), { eventId: 'evt-4' }),
    ];
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];

    const projections = orders.map((order) => {
      const { state } = feed(order.map((index) => events[index] as ScanEvent));
      return {
        aboard: state.aboard,
        directions: [...state.log]
          .map((entry) => `${entry.eventId}:${entry.direction}`)
          .sort(),
      };
    });

    for (const projection of projections) {
      expect(projection).toEqual(projections[0]);
    }
    // Ada: on 08:00, off 08:30, on 08:40. Ben: on 08:10, never off.
    expect(projections[0]?.aboard.map((entry) => entry.studentId)).toEqual([
      BEN.studentId,
      ADA.studentId,
    ]);
  });

  it('breaks occurredAt ties deterministically by eventId regardless of arrival order', () => {
    const a = scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-aaa' });
    const b = scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-bbb' });

    const forward = feed([a, b]).state;
    const backward = feed([b, a]).state;

    expect(directionOf(forward, 'evt-aaa')).toBe('on');
    expect(directionOf(forward, 'evt-bbb')).toBeNull();
    expect(directionOf(backward, 'evt-aaa')).toBe('on');
    expect(directionOf(backward, 'evt-bbb')).toBeNull();
  });

  it('re-derives debounce suppression when an earlier tap lands late', () => {
    // 08:00:10 arrives first and boards Ada. Then 08:00:00 lands late: it is now
    // the boarding, and 08:00:10 falls inside its debounce window.
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:10'), { eventId: 'evt-late-pair-b' }),
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-late-pair-a' }),
    ]);

    expect(directionOf(state, 'evt-late-pair-a')).toBe('on');
    expect(directionOf(state, 'evt-late-pair-b')).toBeNull();
    expect(isAboard(state, ADA.studentId)).toBe(true);
  });

  it('does not let a late reported tap be swallowed by a debounce window', () => {
    // The derived tap at 08:00:10 arrives first. The reported Inbound at
    // 08:00:00 lands late; on the reported path it boards, and the derived tap
    // then falls inside its window.
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:10'), { eventId: 'evt-derived' }),
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-reported', direction: 'Inbound' }),
    ]);

    expect(directionOf(state, 'evt-reported')).toBe('on');
    expect(directionOf(state, 'evt-derived')).toBeNull();
    expect(isAboard(state, ADA.studentId)).toBe(true);
  });
});

describe('applyScan — wrong bus (D-005)', () => {
  it('boards the student anyway and flags the mismatch', () => {
    const { state, results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00'), { eventId: 'evt-w' }),
    ]);

    expect(results[0]?.applied).toBe(true);
    expect(isAboard(state, CAI.studentId)).toBe(true);
    expect(state.aboard[0]?.wrongBus).toBe(true);
    expect(results[0]?.alerts).toEqual([
      {
        kind: 'wrong_bus',
        studentId: CAI.studentId,
        busId: BUS_12,
        routeRunId: ROUTE_RUN,
        raisedAt: t('08:00:00'),
        triggeringEventId: 'evt-w',
        detail: expect.stringContaining(BUS_ROGUE),
      },
    ]);
  });

  it('never leaks a student name into the alert detail', () => {
    const { results } = feed([scan(CAI.verkadaUserId, t('08:00:00'))]);
    const detail = results[0]?.alerts[0]?.detail ?? '';

    expect(detail).not.toContain(CAI.firstName);
    expect(detail).not.toContain(CAI.lastName);
  });

  it('does not leak the Verkada user id or raw card value into the alert detail', () => {
    const { results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00'), { cardId: cardId('109|35302') }),
    ]);
    const detail = results[0]?.alerts[0]?.detail ?? '';

    expect(detail).not.toContain(CAI.verkadaUserId);
    expect(detail).not.toContain('109|35302');
    expect(detail).toContain(CAI.studentId);
  });

  it('does not flag a student on their assigned bus', () => {
    const { state, results } = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);

    expect(results[0]?.alerts).toEqual([]);
    expect(state.aboard[0]?.wrongBus).toBe(false);
  });

  it('does not alert on the exit scan', () => {
    const { results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00')),
      scan(CAI.verkadaUserId, t('08:30:00')),
    ]);

    expect(results[1]?.alerts).toEqual([]);
  });

  it('alerts once per run even if the student re-boards the wrong bus', () => {
    const { results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00')),
      scan(CAI.verkadaUserId, t('08:10:00')),
      scan(CAI.verkadaUserId, t('08:20:00')),
    ]);

    expect(results.flatMap((r) => r.alerts)).toHaveLength(1);
  });

  it('alerts once per run on the reported path too', () => {
    const { results } = feed([
      scan(CAI.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(CAI.verkadaUserId, t('08:10:00'), { direction: 'Outbound' }),
      scan(CAI.verkadaUserId, t('08:20:00'), { direction: 'Inbound' }),
    ]);

    expect(results.flatMap((r) => r.alerts)).toHaveLength(1);
  });

  it('does not double-alert when a late arrival reshuffles which tap is the boarding', () => {
    // The 08:30 tap arrives first and reads as a boarding, raising the alert.
    // The 08:00 tap then lands late and becomes the real boarding; the alert
    // must not be raised a second time.
    const { state, results } = feed([
      scan(CAI.verkadaUserId, t('08:30:00'), { eventId: 'evt-late-off' }),
      scan(CAI.verkadaUserId, t('08:00:00'), { eventId: 'evt-late-on' }),
    ]);

    expect(results.flatMap((r) => r.alerts)).toHaveLength(1);
    expect(state.wrongBusAlerted).toEqual([CAI.studentId]);
  });
});

describe('applyScan — unknown user (D-007)', () => {
  it('returns unknown_user for a Verkada user not on the roster', () => {
    const event = scan(userId('user-not-in-roster'), t('08:00:00'));
    const before = newRun();
    const outcome = applyScan(before, event, { lookupUser: roster });

    expect(outcome.result).toEqual({ applied: false, reason: 'unknown_user', alerts: [] });
    expect(outcome.state).toBe(before);
    expect(outcome.state.log).toEqual([]);
  });

  it('returns unknown_user when the event carries no verkadaUserId at all', () => {
    const before = newRun();
    const outcome = applyScan(before, unmatchedScan(t('08:00:00')), { lookupUser: roster });

    expect(outcome.result).toEqual({ applied: false, reason: 'unknown_user', alerts: [] });
    expect(outcome.state).toBe(before);
  });

  it('does not resolve a student by cardId when the user id is missing', () => {
    // cardId is audit-only and its format is not stable (D-007) — it must never
    // become a fallback key.
    const outcome = applyScan(
      newRun(),
      unmatchedScan(t('08:00:00'), { cardId: cardId('109|35302') }),
      { lookupUser: rosterOf(ADA, BEN, CAI) },
    );

    expect(outcome.result.reason).toBe('unknown_user');
  });

  it('does not block later valid scans', () => {
    const { state } = feed([
      scan(userId('user-ghost'), t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:01:00')),
    ]);

    expect(isAboard(state, ADA.studentId)).toBe(true);
  });

  it('stays unknown_user on redelivery rather than becoming a duplicate', () => {
    const event = scan(userId('user-ghost'), t('08:00:00'), { eventId: 'evt-ghost' });
    const { results } = feed([event, event]);

    expect(results[0]?.reason).toBe('unknown_user');
    expect(results[1]?.reason).toBe('unknown_user');
  });
});

describe('applyScan — malformed and misrouted events', () => {
  it('rejects an event for a different bus as unknown_reader', () => {
    const before = newRun();
    const outcome = applyScan(
      before,
      scan(ADA.verkadaUserId, t('08:00:00'), { busId: BUS_ROGUE }),
      { lookupUser: roster },
    );

    expect(outcome.result).toEqual({ applied: false, reason: 'unknown_reader', alerts: [] });
    expect(outcome.state).toBe(before);
  });

  it('rejects an unparseable occurredAt instead of corrupting the ordering', () => {
    const before = newRun();
    const outcome = applyScan(
      before,
      { ...scan(ADA.verkadaUserId, t('08:00:00')), occurredAt: 'not-a-timestamp' },
      { lookupUser: roster },
    );

    expect(outcome.result).toEqual({ applied: false, reason: 'stale_event', alerts: [] });
    expect(outcome.state).toBe(before);
  });

  it('never throws on any rejection path', () => {
    const cases: ScanEvent[] = [
      scan(userId('user-ghost'), t('08:00:00')),
      unmatchedScan(t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:00:00'), { busId: BUS_ROGUE }),
      scan(ADA.verkadaUserId, t('08:00:00'), { accepted: false }),
      { ...scan(ADA.verkadaUserId, t('08:00:00')), occurredAt: '' },
    ];

    for (const event of cases) {
      expect(() => applyScan(newRun(), event, { lookupUser: roster })).not.toThrow();
    }
  });
});

describe('applyScan — closed runs', () => {
  it('rejects scans after the run is closed', () => {
    const { state } = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);
    const closed = closeRouteRun(
      reconcileRouteRun(state, { at: t('08:45:00') }).state,
      t('09:00:00'),
    );

    const outcome = applyScan(
      closed,
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-late' }),
      { lookupUser: roster },
    );

    expect(outcome.result).toEqual({ applied: false, reason: 'stale_event', alerts: [] });
    expect(outcome.state).toBe(closed);
  });

  it('still answers duplicate for an event already in a closed run', () => {
    const { state } = feed([scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-a' })]);
    const closed = closeRouteRun(state, t('09:00:00'));
    const outcome = applyScan(
      closed,
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-a' }),
      { lookupUser: roster },
    );

    expect(outcome.result.reason).toBe('duplicate_event');
  });
});

describe('applyScan — re-boarding within one run', () => {
  it('handles board, exit, re-board and leaves the student aboard', () => {
    const { state, results } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on-1' }),
      scan(ADA.verkadaUserId, t('08:20:00'), { eventId: 'evt-off-1' }),
      scan(ADA.verkadaUserId, t('08:25:00'), { eventId: 'evt-on-2' }),
    ]);

    expect(results.map((r) => r.scan?.direction)).toEqual(['on', 'off', 'on']);
    expect(state.aboard).toEqual([
      {
        studentId: ADA.studentId,
        boardedAt: t('08:25:00'),
        boardingEventId: 'evt-on-2',
        wrongBus: false,
      },
    ]);
  });

  it('keeps the full ride history in the log', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:20:00')),
      scan(ADA.verkadaUserId, t('08:25:00')),
      scan(ADA.verkadaUserId, t('08:40:00')),
    ]);

    expect(state.log.map((entry) => entry.direction)).toEqual(['on', 'off', 'on', 'off']);
    expect(state.aboard).toEqual([]);
  });
});

describe('state helpers', () => {
  it('reports an empty manifest for a fresh run', () => {
    const state = newRun();

    expect(toManifest(state)).toEqual({
      busId: BUS_12,
      routeRunId: ROUTE_RUN,
      aboard: [],
      updatedAt: t('07:50:00'),
    });
    expect(isAboard(state, ADA.studentId)).toBe(false);
    expect(directionOf(state, 'nope')).toBeUndefined();
    expect(directionSourceOf(state, 'nope')).toBeUndefined();
    expect(directionContradictions(state)).toEqual([]);
  });

  it('does not mutate the state it was given', () => {
    const before = newRun();
    const snapshot = JSON.stringify(before);
    applyScan(before, scan(ADA.verkadaUserId, t('08:00:00')), { lookupUser: roster });

    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('re-projects the log on restore, self-healing a stale snapshot', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on' }),
      scan(BEN.verkadaUserId, t('08:05:00'), { eventId: 'evt-ben' }),
    ]);

    // Persistence wrote the wrong direction; restore must not trust it.
    const corrupted = state.log.map((entry) => ({
      ...entry,
      direction: 'off' as const,
      directionSource: 'device' as const,
      contradictsDerived: true,
    }));
    const restored = restoreRouteRunState({
      busId: BUS_12,
      routeRunId: ROUTE_RUN,
      startedAt: t('07:50:00'),
      log: corrupted,
    });

    expect(directionOf(restored, 'evt-on')).toBe('on');
    expect(directionSourceOf(restored, 'evt-on')).toBe('derived');
    expect(directionContradictions(restored)).toEqual([]);
    expect(restored.aboard.map((entry) => entry.studentId)).toEqual([
      ADA.studentId,
      BEN.studentId,
    ]);
  });

  it('re-projects a reported direction from reportedDirection, not from direction', () => {
    const { state } = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in', direction: 'Inbound' }),
    ]);
    const corrupted = state.log.map((entry) => ({ ...entry, direction: 'off' as const }));
    const restored = restoreRouteRunState({
      busId: BUS_12,
      routeRunId: ROUTE_RUN,
      startedAt: t('07:50:00'),
      log: corrupted,
    });

    expect(directionOf(restored, 'evt-in')).toBe('on');
    expect(directionSourceOf(restored, 'evt-in')).toBe('device');
    expect(isAboard(restored, ADA.studentId)).toBe(true);
  });

  it('restores an empty run without ceremony', () => {
    const restored = restoreRouteRunState({
      busId: BUS_12,
      routeRunId: ROUTE_RUN,
      startedAt: t('07:50:00'),
    });

    expect(restored.log).toEqual([]);
    expect(restored.aboard).toEqual([]);
    expect(restored.reconciledAt).toBeUndefined();
  });

  it('ignores a student id that was never seen', () => {
    const { state } = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);

    expect(isAboard(state, studentId('stu-nobody'))).toBe(false);
  });
});
