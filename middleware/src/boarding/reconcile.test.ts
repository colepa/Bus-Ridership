import { describe, expect, it } from 'vitest';

import type { ScanEvent } from '../types/events.js';
import {
  RECONCILE_SETTLE_WINDOW_MS,
  closeRouteRun,
  needsReconciliation,
  reconcileRouteRun,
} from './reconcile.js';
import {
  applyScan,
  createRouteRunState,
  isAboard,
  type RosterLookup,
  type RouteRunState,
} from './stateMachine.js';
import {
  BUS_12,
  BUS_ROGUE,
  ROUTE_RUN,
  rosterOf,
  scan,
  student,
  t,
  unmatchedScan,
  userId,
} from './testFixtures.js';

const ADA = student('stu-ada', 'user-ada-0001');
const BEN = student('stu-ben', 'user-ben-0002');
const CAI = student('stu-cai', 'user-cai-0003', BUS_ROGUE);

const roster = rosterOf(ADA, BEN, CAI);

function newRun(): RouteRunState {
  return createRouteRunState({ busId: BUS_12, routeRunId: ROUTE_RUN, startedAt: t('07:50:00') });
}

function feed(
  events: readonly ScanEvent[],
  initial: RouteRunState = newRun(),
  lookup: RosterLookup = roster,
): RouteRunState {
  let state = initial;
  for (const event of events) {
    state = applyScan(state, event, { lookupUser: lookup }).state;
  }
  return state;
}

/** Long enough after the last delivery that the settle window has elapsed. */
const QUIET = t('09:30:00');

describe('reconcileRouteRun — the never-scanned-off safeguard', () => {
  it('raises an alert for a student scanned on and never off', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on' })]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.clear).toBe(false);
    expect(result.alerts).toEqual([
      {
        kind: 'never_scanned_off',
        studentId: ADA.studentId,
        busId: BUS_12,
        routeRunId: ROUTE_RUN,
        raisedAt: QUIET,
        detail: expect.stringContaining(t('08:00:00')),
      },
    ]);
    expect(result.alerts[0]).not.toHaveProperty('triggeringEventId');
    expect(result.newlyAlerted).toEqual([ADA.studentId]);
    expect(result.stillAboard.map((entry) => entry.studentId)).toEqual([ADA.studentId]);
  });

  it('raises one alert per student still aboard', () => {
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(BEN.verkadaUserId, t('08:05:00')),
      scan(CAI.verkadaUserId, t('08:06:00')),
      scan(BEN.verkadaUserId, t('08:40:00')), // Ben gets off
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.alerts.map((alert) => alert.studentId).sort()).toEqual(
      [ADA.studentId, CAI.studentId].sort(),
    );
  });

  it('reports a clean run with no alerts', () => {
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:30:00')),
      scan(BEN.verkadaUserId, t('08:05:00')),
      scan(BEN.verkadaUserId, t('08:35:00')),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.alerts).toEqual([]);
    expect(result.clear).toBe(true);
    expect(result.newlyAlerted).toEqual([]);
  });

  it('does not put a student name in the alert detail', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);
    const detail = reconcileRouteRun(state, { at: QUIET }).alerts[0]?.detail ?? '';

    expect(detail).not.toContain(ADA.firstName);
    expect(detail).not.toContain(ADA.lastName);
    expect(detail).toContain(ADA.studentId);
  });

  it('still alerts on a student whose only taps were a debounced double-tap', () => {
    // The double-tap collapses to one boarding, so they are aboard and unaccounted for.
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-1' }),
      scan(ADA.verkadaUserId, t('08:00:02'), { eventId: 'evt-2' }),
    ]);

    expect(reconcileRouteRun(state, { at: QUIET }).alerts).toHaveLength(1);
  });

  it('alerts on a student who boarded, exited and re-boarded without a final exit', () => {
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:20:00')),
      scan(ADA.verkadaUserId, t('08:25:00')),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.alerts).toHaveLength(1);
    expect(result.stillAboard[0]?.boardedAt).toBe(t('08:25:00'));
  });

  it('does not alert on a student who boarded, exited and re-boarded and then exited', () => {
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00')),
      scan(ADA.verkadaUserId, t('08:20:00')),
      scan(ADA.verkadaUserId, t('08:25:00')),
      scan(ADA.verkadaUserId, t('08:45:00')),
    ]);

    expect(reconcileRouteRun(state, { at: QUIET }).clear).toBe(true);
  });

  it('alerts on a student the door reported Inbound and never Outbound', () => {
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-in', direction: 'Inbound' }),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.alerts.map((alert) => alert.studentId)).toEqual([ADA.studentId]);
    expect(result.stillAboard[0]?.boardingEventId).toBe('evt-in');
  });

  it('clears on a reported Outbound', () => {
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { direction: 'Outbound' }),
    ]);

    expect(reconcileRouteRun(state, { at: QUIET }).clear).toBe(true);
  });

  it('alerts on a mixed run where the boarding was reported and no exit ever came', () => {
    // Door reconfigured mid-run: Ada boards through an In/Out Door, Ben boards
    // through one that reports nothing. Neither scans off.
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { direction: 'Inbound' }),
      scan(BEN.verkadaUserId, t('08:05:00')),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.alerts.map((alert) => alert.studentId).sort()).toEqual(
      [ADA.studentId, BEN.studentId].sort(),
    );
  });

  it('does not let a rejected credential silence the alert (D-009)', () => {
    // Ada boarded, then her card was refused on the way out. She never got a
    // validated exit, so she is still unaccounted for. This is the whole point.
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-on' }),
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-rej', accepted: false }),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.clear).toBe(false);
    expect(result.alerts.map((alert) => alert.studentId)).toEqual([ADA.studentId]);
  });

  it('alerts on a wrong-bus student the same as any other', () => {
    const state = feed([scan(CAI.verkadaUserId, t('08:00:00'))]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.alerts.map((alert) => alert.kind)).toEqual(['never_scanned_off']);
    expect(result.stillAboard[0]?.wrongBus).toBe(true);
  });
});

describe('reconcileRouteRun — degenerate runs', () => {
  it('handles a run with no events at all', () => {
    const result = reconcileRouteRun(newRun(), { at: QUIET });

    expect(result).toMatchObject({
      alerts: [],
      stillAboard: [],
      newlyAlerted: [],
      clearedStudentIds: [],
      clear: true,
      provisional: false,
      reconciledAt: QUIET,
    });
  });

  it('handles a run whose only events were unknown users', () => {
    const state = feed([
      scan(userId('user-ghost'), t('08:00:00')),
      unmatchedScan(t('08:01:00')),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(state.log).toEqual([]);
    expect(result.clear).toBe(true);
  });

  it('handles a run whose only events were rejected credentials (D-009)', () => {
    // A student tried and was refused. Nobody boarded, so nobody is aboard —
    // and a refused tap must not manufacture a never_scanned_off alert.
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { eventId: 'evt-rej', accepted: false }),
    ]);
    const result = reconcileRouteRun(state, { at: QUIET });

    expect(state.log).toEqual([]);
    expect(result.alerts).toEqual([]);
    expect(result.clear).toBe(true);
  });

  it('is safe to reconcile the same clean run repeatedly', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00')), scan(ADA.verkadaUserId, t('08:30:00'))]);
    const first = reconcileRouteRun(state, { at: QUIET });
    const second = reconcileRouteRun(first.state, { at: t('09:35:00') });

    expect(second.alerts).toEqual([]);
    expect(second.clearedStudentIds).toEqual([]);
  });
});

describe('reconcileRouteRun — reconciliation bookkeeping', () => {
  it('marks the run reconciled and no longer stale', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);

    expect(needsReconciliation(state)).toBe(true);

    const result = reconcileRouteRun(state, { at: QUIET });

    expect(result.state.reconciledAt).toBe(QUIET);
    expect(result.state.reconciliationStale).toBe(false);
    expect(needsReconciliation(result.state)).toBe(false);
  });

  it('does not report the same student as newly alerted twice', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);
    const first = reconcileRouteRun(state, { at: QUIET });
    const second = reconcileRouteRun(first.state, { at: t('09:40:00') });

    expect(first.newlyAlerted).toEqual([ADA.studentId]);
    expect(second.newlyAlerted).toEqual([]);
    // Still aboard, so the alert stands — it is re-reported, not forgotten.
    expect(second.alerts).toHaveLength(1);
  });

  it('does not mutate the state it was given', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);
    const snapshot = JSON.stringify(state);
    reconcileRouteRun(state, { at: QUIET });

    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('late events after reconciliation — the buffered cellular burst', () => {
  it('accepts late events on a reconciled run and marks the reconciliation stale', () => {
    const reconciled = reconcileRouteRun(feed([scan(ADA.verkadaUserId, t('08:00:00'))]), {
      at: t('08:45:00'),
    }).state;

    const late = applyScan(
      reconciled,
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-late-off', receivedAt: t('08:50:00') }),
      { lookupUser: roster },
    );

    expect(late.result.applied).toBe(true);
    expect(late.state.reconciliationStale).toBe(true);
    expect(needsReconciliation(late.state)).toBe(true);
    expect(isAboard(late.state, ADA.studentId)).toBe(false);
  });

  it('clears an alert when the missing exit finally arrives', () => {
    const first = reconcileRouteRun(feed([scan(ADA.verkadaUserId, t('08:00:00'))]), {
      at: t('08:45:00'),
    });
    expect(first.alerts).toHaveLength(1);

    const withLateExit = applyScan(
      first.state,
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-late-off', receivedAt: t('08:50:00') }),
      { lookupUser: roster },
    ).state;

    const second = reconcileRouteRun(withLateExit, { at: t('10:00:00') });

    expect(second.alerts).toEqual([]);
    expect(second.clearedStudentIds).toEqual([ADA.studentId]);
    expect(second.clear).toBe(true);

    // Cleared once, not on every subsequent reconciliation.
    const third = reconcileRouteRun(second.state, { at: t('10:05:00') });
    expect(third.clearedStudentIds).toEqual([]);
  });

  it('raises a NEW alert when the burst reveals a boarding nobody knew about', () => {
    // The whole run looked clean; the gateway was offline the entire time and
    // dumps the boarding after reconciliation. This is the false negative the
    // module exists to prevent.
    const first = reconcileRouteRun(newRun(), { at: t('08:45:00') });
    expect(first.alerts).toEqual([]);
    expect(first.clear).toBe(true);

    const burst = feed(
      [
        scan(BEN.verkadaUserId, t('08:05:00'), { eventId: 'evt-b1', receivedAt: t('08:46:00') }),
        scan(ADA.verkadaUserId, t('08:02:00'), { eventId: 'evt-a1', receivedAt: t('08:46:01') }),
        scan(ADA.verkadaUserId, t('08:35:00'), { eventId: 'evt-a2', receivedAt: t('08:46:02') }),
      ],
      first.state,
    );

    const second = reconcileRouteRun(burst, { at: t('10:00:00') });

    expect(second.clear).toBe(false);
    expect(second.alerts.map((alert) => alert.studentId)).toEqual([BEN.studentId]);
    expect(second.newlyAlerted).toEqual([BEN.studentId]);
  });

  it('lands an out-of-order burst correctly regardless of delivery order', () => {
    // Exit arrives before boarding, both after reconciliation.
    const first = reconcileRouteRun(newRun(), { at: t('08:45:00') });
    const burst = feed(
      [
        scan(ADA.verkadaUserId, t('08:35:00'), { eventId: 'evt-off', receivedAt: t('08:46:00') }),
        scan(ADA.verkadaUserId, t('08:02:00'), { eventId: 'evt-on', receivedAt: t('08:46:01') }),
      ],
      first.state,
    );

    expect(reconcileRouteRun(burst, { at: t('10:00:00') }).clear).toBe(true);
  });

  it('refuses late events once the run is closed', () => {
    const reconciled = reconcileRouteRun(feed([scan(ADA.verkadaUserId, t('08:00:00'))]), {
      at: QUIET,
    }).state;
    const closed = closeRouteRun(reconciled, t('09:35:00'));

    const outcome = applyScan(
      closed,
      scan(ADA.verkadaUserId, t('08:30:00'), { eventId: 'evt-too-late', receivedAt: t('10:00:00') }),
      { lookupUser: roster },
    );

    expect(outcome.result).toEqual({ applied: false, reason: 'stale_event', alerts: [] });
    expect(reconcileRouteRun(outcome.state, { at: t('10:00:00') }).alerts).toHaveLength(1);
  });
});

describe('reconcileRouteRun — provisional results while the link is buffering', () => {
  it('is provisional when we heard from the bus moments ago', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'), { receivedAt: t('08:44:30') })]);
    const result = reconcileRouteRun(state, { at: t('08:45:00') });

    expect(result.provisional).toBe(true);
    // Provisional never suppresses the alert.
    expect(result.alerts).toHaveLength(1);
  });

  it('is not provisional once the link has been quiet for the settle window', () => {
    const lastHeard = t('08:00:00');
    const settled = new Date(Date.parse(lastHeard) + RECONCILE_SETTLE_WINDOW_MS).toISOString();
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'), { receivedAt: lastHeard })]);

    expect(reconcileRouteRun(state, { at: settled }).provisional).toBe(false);
  });

  it('extends the settle window to the worst delivery lag actually observed', () => {
    // A 30-minute buffered delivery proves the link can be 30 minutes behind,
    // so five minutes of quiet is not enough to call the run final.
    const state = feed([
      scan(ADA.verkadaUserId, t('08:00:00'), { receivedAt: t('08:30:00') }),
      scan(BEN.verkadaUserId, t('08:31:00'), { receivedAt: t('08:31:00') }),
    ]);

    expect(reconcileRouteRun(state, { at: t('08:36:00') }).provisional).toBe(true);
    expect(reconcileRouteRun(state, { at: t('09:10:00') }).provisional).toBe(false);
  });

  it('is not provisional for a run with no events to wait on', () => {
    expect(reconcileRouteRun(newRun(), { at: t('07:50:01') }).provisional).toBe(false);
  });

  it('honours an overridden settle window', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'), { receivedAt: t('08:00:00') })]);

    expect(
      reconcileRouteRun(state, { at: t('08:00:05'), settleWindowMs: 1_000 }).provisional,
    ).toBe(false);
    expect(
      reconcileRouteRun(state, { at: t('08:00:05'), settleWindowMs: 60_000 }).provisional,
    ).toBe(true);
  });
});

describe('closeRouteRun', () => {
  it('stamps the close time and leaves the manifest intact', () => {
    const state = feed([scan(ADA.verkadaUserId, t('08:00:00'))]);
    const closed = closeRouteRun(state, t('09:00:00'));

    expect(closed.closedAt).toBe(t('09:00:00'));
    expect(closed.aboard).toEqual(state.aboard);
  });

  it('does not erase an outstanding never-scanned-off alert', () => {
    const reconciled = reconcileRouteRun(feed([scan(ADA.verkadaUserId, t('08:00:00'))]), {
      at: QUIET,
    }).state;
    const closed = closeRouteRun(reconciled, t('09:35:00'));

    expect(reconcileRouteRun(closed, { at: t('09:40:00') }).alerts).toHaveLength(1);
  });
});
