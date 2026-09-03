/**
 * End-of-route reconciliation — the child-left-on-bus safeguard.
 *
 * Pure and in-memory like `stateMachine.ts`: state in, alerts out, no clock and
 * no I/O. The caller passes the wall-clock instant as `at`.
 *
 * ---------------------------------------------------------------------------
 * NO FALSE NEGATIVES
 * ---------------------------------------------------------------------------
 * A missed alert means a child asleep on a bus in a hot parking lot. A spurious
 * alert means a driver walks the aisle for nothing. Those costs are not
 * comparable, so every rule here resolves towards raising the alert:
 *
 *  - Anyone the projection says is aboard raises `never_scanned_off`. There is
 *    no suppression, no grace list, no "probably fine" branch.
 *  - Reconciliation is *repeatable and non-destructive*. It never closes the
 *    run and never blocks later scans, so a burst of events that arrives after
 *    reconciliation cannot be lost.
 *  - A refused tap is not an exit. `applyScan` drops `*_rejected` credential
 *    events before they reach the log (D-009), so a student whose card failed
 *    on the way off the bus stays aboard and stays alerted. Resolving that
 *    towards "probably left" is exactly the false negative to avoid.
 *  - When the cellular link has been demonstrably buffering, the result is
 *    marked `provisional`. Provisional still raises every alert — it only tells
 *    the caller to reconcile again once the link has been quiet, because more
 *    events may still land.
 *
 * ---------------------------------------------------------------------------
 * LATE EVENTS AFTER RECONCILIATION
 * ---------------------------------------------------------------------------
 * The GC31-E buffers while out of coverage and dumps everything at once when it
 * reconnects — often after the run has ended and been reconciled. Policy:
 *
 *  1. Reconciled is not closed. `applyScan` keeps accepting events for a
 *     reconciled run; the state just flips `reconciliationStale = true`.
 *     Dropping them would be worse than useless: dropping a late *exit* leaves
 *     a false `never_scanned_off`, and dropping a late *boarding* hides a child
 *     who was on the bus — exactly the false negative this module exists to
 *     prevent.
 *  2. Re-running `reconcileRouteRun` produces the corrected picture, reporting
 *     `clearedStudentIds` for students whose alert the late data resolves and
 *     `newlyAlerted` for students the late data has just revealed.
 *  3. `closeRouteRun` is the terminal step, taken by staff after a
 *     non-provisional reconciliation has been reviewed. Only after close are
 *     late events rejected (`stale_event`), so nothing silently rewrites a run
 *     that has already been signed off.
 */

import type { Alert, ManifestEntry, StudentId } from '../types/events.js';
import type { RouteRunState } from './stateMachine.js';

/**
 * How long the link must be quiet before a reconciliation is treated as final.
 * Two minutes: long enough to cover a short coverage gap at a school loop or a
 * cell handover, short enough that the driver is still at the vehicle. If the
 * gateway has already demonstrated a worse lag this run, that observed lag is
 * used instead — the link tells us how far behind it can get.
 */
export const RECONCILE_SETTLE_WINDOW_MS = 120_000;

export interface ReconcileOptions {
  /** Wall-clock instant of reconciliation, ISO 8601 UTC. Injected, not read. */
  readonly at: string;
  /** Override for tests. Defaults to `RECONCILE_SETTLE_WINDOW_MS`. */
  readonly settleWindowMs?: number;
}

export interface ReconcileResult {
  readonly state: RouteRunState;
  readonly reconciledAt: string;
  /** One `never_scanned_off` per student still aboard. Empty means the bus is clear. */
  readonly alerts: readonly Alert[];
  readonly stillAboard: readonly ManifestEntry[];
  /** Still-aboard students not flagged by a previous reconciliation of this run. */
  readonly newlyAlerted: readonly StudentId[];
  /** Previously flagged students whose late-arriving exit has since landed. */
  readonly clearedStudentIds: readonly StudentId[];
  /** True when nobody is aboard. */
  readonly clear: boolean;
  /**
   * True when events may still be in flight (the link has been buffering and
   * has not been quiet for the settle window). Alerts are raised regardless;
   * this only means "reconcile again before closing the run".
   */
  readonly provisional: boolean;
}

/**
 * Reconcile a route run. Safe to call repeatedly; each call returns the current
 * truth and the delta against the previous call.
 */
export function reconcileRouteRun(
  state: RouteRunState,
  options: ReconcileOptions,
): ReconcileResult {
  const settleWindowMs = options.settleWindowMs ?? RECONCILE_SETTLE_WINDOW_MS;
  const stillAboard = [...state.aboard];
  const aboardIds = stillAboard.map((entry) => entry.studentId);

  const alerts: Alert[] = stillAboard.map((entry) => ({
    kind: 'never_scanned_off',
    studentId: entry.studentId,
    busId: state.busId,
    routeRunId: state.routeRunId,
    raisedAt: options.at,
    // No triggeringEventId: nothing happened, that is the entire problem.
    // No names: hard rule, no full student records in logs or messages.
    detail:
      `Student ${entry.studentId} scanned on to bus ${state.busId} at ${entry.boardedAt} ` +
      `and never scanned off before the end of route run ${state.routeRunId}. ` +
      `Check the vehicle before leaving it.`,
  }));

  const newlyAlerted = aboardIds.filter((id) => !state.neverScannedOffAlerted.includes(id));
  const clearedStudentIds = state.neverScannedOffAlerted.filter((id) => !aboardIds.includes(id));

  const nextState: RouteRunState = {
    ...state,
    reconciledAt: options.at,
    reconciliationStale: false,
    // Replaces, not appends: a student who has been cleared must not be
    // reported as cleared a second time by the next reconciliation.
    neverScannedOffAlerted: aboardIds,
  };

  return {
    state: nextState,
    reconciledAt: options.at,
    alerts,
    stillAboard,
    newlyAlerted,
    clearedStudentIds,
    clear: stillAboard.length === 0,
    provisional: isProvisional(state, options.at, settleWindowMs),
  };
}

/**
 * Close a route run. Terminal: `applyScan` rejects everything afterwards with
 * `stale_event`. Only close once `reconcileRouteRun` has returned
 * `provisional: false` and its alerts have been reviewed — closing early throws
 * away the buffered events that would have cleared them.
 */
export function closeRouteRun(state: RouteRunState, at: string): RouteRunState {
  return { ...state, closedAt: at, updatedAt: at };
}

/** True when reconciliation should be re-run before the run is trusted. */
export function needsReconciliation(state: RouteRunState): boolean {
  return state.reconciledAt === undefined || state.reconciliationStale;
}

/**
 * Have we been quiet long enough to believe the run is complete?
 *
 * The bar is the larger of the configured settle window and the worst
 * delivery lag actually observed this run: a gateway that has already been
 * twenty minutes behind can be twenty minutes behind again.
 */
function isProvisional(state: RouteRunState, at: string, settleWindowMs: number): boolean {
  if (state.log.length === 0) return false;

  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return true; // cannot prove we are settled

  let worstLagMs = 0;
  let lastHeardMs = Number.NEGATIVE_INFINITY;

  for (const entry of state.log) {
    const receivedMs = Date.parse(entry.receivedAt);
    const occurredMs = Date.parse(entry.occurredAt);
    if (Number.isNaN(receivedMs)) continue;
    if (receivedMs > lastHeardMs) lastHeardMs = receivedMs;
    if (!Number.isNaN(occurredMs)) {
      worstLagMs = Math.max(worstLagMs, receivedMs - occurredMs);
    }
  }

  if (lastHeardMs === Number.NEGATIVE_INFINITY) return true;

  const quietForMs = atMs - lastHeardMs;
  return quietForMs < Math.max(settleWindowMs, worstLagMs);
}
