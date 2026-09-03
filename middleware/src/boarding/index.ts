/**
 * Boarding logic — public surface.
 *
 * Pure and dependency-free. Give it a `RouteRunState` and a `ScanEvent`, get
 * back new state plus alerts; hand the run to `reconcileRouteRun` at the end.
 * Nothing in here touches a database, an HTTP layer, or the clock.
 *
 * Identity is `verkadaUserId` throughout (D-007). `cardId` is carried on the
 * log for audit and is never used as a key — `input_value` is not stable across
 * event types.
 *
 * Known gaps against the shared contract (`../types/events.ts`) — flagged, not
 * patched, since that file is owned elsewhere:
 *
 *  - `AlertKind` has no kind for a direction contradiction. When a door reports
 *    a direction that disagrees with what derivation would have concluded, the
 *    reported value wins (revised D-002) and the disagreement is recorded on
 *    the log entry as `contradictsDerived`, readable via
 *    `directionContradictions(state)`. It raises no `Alert`, so the caller has
 *    to poll state for it. Worth a third `AlertKind` before the pilot: an
 *    Outbound reported for a student we never saw board means either a missed
 *    tap or a mis-mapped reader, and both are worth a human look.
 *  - `RejectionReason` has no `malformed_event`. A scan whose `occurredAt` will
 *    not parse cannot be ordered, so it is reported as `stale_event`. Schema
 *    validation upstream should mean this never fires.
 *  - `not_a_scan_event` is never returned from here. Filtering non-credential
 *    notification types (door held open, tamper, fire alarm, aux input — D-009)
 *    happens in the webhook adapter, which is the only module that knows the
 *    `notification_type` vocabulary. This module only ever sees taps.
 *  - Out-of-order arrival is handled by replay, not rejection (D-003) —
 *    rejecting a late event is how a child gets dropped from a manifest.
 */

export {
  DEBOUNCE_WINDOW_MS,
  applyScan,
  createRouteRunState,
  directionContradictions,
  directionOf,
  directionSourceOf,
  isAboard,
  restoreRouteRunState,
  toManifest,
} from './stateMachine.js';
export type {
  ApplyOutcome,
  ApplyScanOptions,
  CreateRouteRunInput,
  LoggedScan,
  RosterLookup,
  RouteRunState,
} from './stateMachine.js';

export {
  RECONCILE_SETTLE_WINDOW_MS,
  closeRouteRun,
  needsReconciliation,
  reconcileRouteRun,
} from './reconcile.js';
export type { ReconcileOptions, ReconcileResult } from './reconcile.js';
