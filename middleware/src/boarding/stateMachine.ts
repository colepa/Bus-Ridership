/**
 * Boarding / exit state machine.
 *
 * Pure, in-memory, dependency-free: this module takes (state, event) and
 * returns (new state, ApplyResult). It performs no I/O, holds no globals, and
 * reads no clock. Persistence, HTTP, and the roster database live elsewhere;
 * the roster is reached only through an injected `RosterLookup`.
 *
 * ---------------------------------------------------------------------------
 * STATE MODEL — event-sourced with replay
 * ---------------------------------------------------------------------------
 * A route run's state is an ordered log of accepted scans plus a projection
 * (who is aboard) derived from it. Every accepted scan is inserted into the log
 * and the *whole* log is re-projected in `occurredAt` order.
 *
 * Why not just flip a boolean per student as taps arrive? Because D-002 still
 * *derives* direction from current boarding state whenever the door does not
 * report one, and D-003 says events arrive out of order. Those two together are
 * a trap: if a student's 08:10 exit is delivered before their 08:00 boarding,
 * incremental processing reads the exit as a boarding (student not aboard yet)
 * and then reads the real boarding as an exit. The child ends the run looking
 * not-aboard when they never scanned off — a false negative on the safeguard
 * that matters most.
 *
 * Replaying the log in `occurredAt` order makes late arrivals land correctly by
 * construction. The cost, which callers must handle, is that the derived
 * direction of an *already-applied* event can change when an earlier event
 * shows up late. Persistence should upsert directions from `state.log` after
 * every apply rather than treating the first answer as final. Device-reported
 * directions are stable under replay; only derived ones move.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION: REPORTED BEATS DERIVED (revised D-002)
 * ---------------------------------------------------------------------------
 * Verkada populates `data.direction` only when the door is configured as an
 * In/Out Door. So per tap, independently:
 *
 *  - `deviceDirection` present -> `direction` is that, `directionSource` is
 *    'device'. The debounce heuristic does NOT run: a reported Inbound is a
 *    boarding even if it follows another reported Inbound three seconds
 *    earlier. Debounce exists to paper over a guess; there is nothing to guess.
 *  - `deviceDirection` absent -> derive from the projection (`aboard ? off :
 *    on`) with the debounce window, `directionSource` is 'derived'.
 *
 * The decision is per event, not per run, so a run may legitimately mix the two
 * — a door reconfigured mid-route, or a bus with a front In/Out door and a rear
 * door that is not. Mixed runs need no special case: device taps set the
 * projection authoritatively and later derived taps continue from whatever the
 * projection now says. The debounce clock is advanced by device taps too, so a
 * derived tap arriving seconds after a device tap is still suppressed rather
 * than read as an instant reversal.
 *
 * CONTRADICTIONS. When a reported direction disagrees with what derivation
 * would have concluded (a reported Inbound for a student the projection already
 * has aboard, or a reported Outbound for one it does not), the reported value
 * wins — the door hardware observed the student; our model only inferred them.
 * But the disagreement is real signal and is recorded on the log entry as
 * `contradictsDerived`, readable via `directionContradictions`. Causes worth
 * investigating: a missed tap earlier in the run, a genuine double-tap on an
 * In/Out door, a reader mapped to the wrong bus, or a student who boarded
 * before the run was opened. Note the safety asymmetry — an Inbound
 * contradiction keeps the student aboard (safe), an Outbound contradiction was
 * already going to leave them off the manifest since we never saw them board.
 * The contract has no `AlertKind` for this, so it is surfaced as state rather
 * than as an `Alert`; see the note in `index.ts`.
 */

import type {
  Alert,
  ApplyResult,
  BusId,
  BusManifest,
  CardId,
  DeviceDirection,
  DirectionSource,
  ManifestEntry,
  RejectionReason,
  ResolvedScan,
  ScanDirection,
  ScanEvent,
  StudentAssignment,
  StudentId,
  VerkadaUserId,
} from '../types/events.js';

/**
 * Taps from the same student closer together than this are treated as one tap.
 * Applies to the DERIVED path only (revised D-002) — a device-reported
 * direction is never debounced. Chosen at 15s because:
 *  - Readers re-read a card held at the panel every 1-2s, and a student who
 *    does not see the confirmation light taps again within a second or two, so
 *    real double-taps cluster far under 15s.
 *  - The fastest *genuine* board-then-exit is much slower: a student has to
 *    board, realise the mistake, and get back past the door. Stop dwell alone
 *    is typically 20-60s. Nothing legitimate rides a bus for 15 seconds.
 * Erring long would swallow real exits; erring short would let a nervous
 * double-tap read as an instant exit and drop a child off the manifest. 15s
 * sits in the gap with room on both sides.
 *
 * Configuring the door as an In/Out Door retires this heuristic entirely, which
 * is why D-002 recommends it for the pilot.
 */
export const DEBOUNCE_WINDOW_MS = 15_000;

/**
 * Roster resolution, injected. Keyed on `verkadaUserId` — the Verkada access
 * user, not the card number (D-007): `input_value` is not stable across event
 * types, so keying off it would break silently.
 *
 * MUST be synchronous, total and non-throwing: resolve the roster (DB, cache)
 * before calling into this module and pass a plain lookup. An unresolvable user
 * returns `undefined`, never an exception — the webhook still has to 2xx
 * (D-004).
 */
export type RosterLookup = (userId: VerkadaUserId) => StudentAssignment | undefined;

/**
 * One scan accepted into a route run's history.
 *
 * `direction` and `directionSource` are *computed*, not stored input, and are
 * recomputed on every replay from `reportedDirection` plus the projection.
 * `direction: null` means the tap was suppressed by the debounce window: it
 * stays in the log (so idempotency holds and so a later-arriving earlier event
 * can change which taps are suppressed) but it does not move the student. Only
 * derived taps can be suppressed.
 *
 * No `clipRef` and no GPS: the access webhook carries neither (D-008). Both are
 * `ScanEnrichment`, fetched from Command afterwards and joined in at read time.
 */
export interface LoggedScan {
  readonly eventId: string;
  readonly studentId: StudentId;
  /** Primary identity key (D-007). */
  readonly verkadaUserId: VerkadaUserId;
  /** Raw `input_value`, carried for audit only. Nothing keys off it (D-007). */
  readonly cardId?: CardId;
  readonly occurredAt: string;
  readonly receivedAt: string;
  /** What the door reported, when it is an In/Out Door. Input, not computed. */
  readonly reportedDirection?: DeviceDirection;
  /** Resolved direction; `null` when suppressed by the derived-path debounce. */
  readonly direction: ScanDirection | null;
  /** 'device' whenever `reportedDirection` is set, 'derived' otherwise. */
  readonly directionSource: DirectionSource;
  /**
   * True when a device-reported direction disagreed with what derivation would
   * have concluded. Reported still won. Always false on the derived path.
   */
  readonly contradictsDerived: boolean;
  /** True when the student's assigned bus is not the bus they tapped on. */
  readonly wrongBus: boolean;
}

/** All state for one bus on one route run. Plain, readonly, JSON-serializable. */
export interface RouteRunState {
  readonly busId: BusId;
  readonly routeRunId: string;
  readonly startedAt: string;
  /** Accepted scans, ordered by `occurredAt` then `eventId`. */
  readonly log: readonly LoggedScan[];
  /** Projection of `log`: who is aboard right now. */
  readonly aboard: readonly ManifestEntry[];
  readonly updatedAt: string;
  /** Set by `reconcileRouteRun`. Absent until the run has been reconciled. */
  readonly reconciledAt?: string;
  /** True when scans landed after the last reconciliation, so it must be re-run. */
  readonly reconciliationStale: boolean;
  /** Students already alerted `never_scanned_off`, so re-reconciling can clear them. */
  readonly neverScannedOffAlerted: readonly StudentId[];
  /** Students already alerted `wrong_bus` this run: at most one alert per student. */
  readonly wrongBusAlerted: readonly StudentId[];
  /**
   * Set by `closeRouteRun`. A closed run is terminal: later scans are rejected
   * as `stale_event` instead of silently rewriting a run staff already signed off.
   */
  readonly closedAt?: string;
}

export interface ApplyScanOptions {
  /** Roster resolution by Verkada user id (D-007). */
  readonly lookupUser: RosterLookup;
  /** Override for tests. Defaults to `DEBOUNCE_WINDOW_MS`. Derived path only. */
  readonly debounceWindowMs?: number;
}

/** New state plus the contract-shaped result for the event just handled. */
export interface ApplyOutcome {
  readonly state: RouteRunState;
  readonly result: ApplyResult;
}

export interface CreateRouteRunInput {
  readonly busId: BusId;
  readonly routeRunId: string;
  /** ISO 8601 UTC. Informational only — it never rejects earlier scans. */
  readonly startedAt: string;
}

export function createRouteRunState(input: CreateRouteRunInput): RouteRunState {
  return {
    busId: input.busId,
    routeRunId: input.routeRunId,
    startedAt: input.startedAt,
    log: [],
    aboard: [],
    updatedAt: input.startedAt,
    reconciliationStale: false,
    neverScannedOffAlerted: [],
    wrongBusAlerted: [],
  };
}

/**
 * Rebuild state from persistence. The log is re-projected rather than trusted,
 * so a snapshot written before a late event landed self-heals on load.
 */
export function restoreRouteRunState(
  snapshot: CreateRouteRunInput & {
    readonly log?: readonly LoggedScan[];
    readonly updatedAt?: string;
    readonly reconciledAt?: string;
    readonly reconciliationStale?: boolean;
    readonly neverScannedOffAlerted?: readonly StudentId[];
    readonly wrongBusAlerted?: readonly StudentId[];
    readonly closedAt?: string;
    readonly debounceWindowMs?: number;
  },
): RouteRunState {
  const projected = project(snapshot.log ?? [], snapshot.debounceWindowMs ?? DEBOUNCE_WINDOW_MS);
  return {
    busId: snapshot.busId,
    routeRunId: snapshot.routeRunId,
    startedAt: snapshot.startedAt,
    log: projected.log,
    aboard: projected.aboard,
    updatedAt: snapshot.updatedAt ?? snapshot.startedAt,
    reconciliationStale: snapshot.reconciliationStale ?? false,
    neverScannedOffAlerted: snapshot.neverScannedOffAlerted ?? [],
    wrongBusAlerted: snapshot.wrongBusAlerted ?? [],
    ...(snapshot.reconciledAt !== undefined ? { reconciledAt: snapshot.reconciledAt } : {}),
    ...(snapshot.closedAt !== undefined ? { closedAt: snapshot.closedAt } : {}),
  };
}

/**
 * Apply one scan to a route run.
 *
 * Never throws. Every refusal is an `ApplyResult` with `applied: false` and a
 * `RejectionReason`, so the webhook can still 2xx (D-004).
 *
 * Note the deliberate asymmetry: a debounced tap returns `applied: false` but
 * *does* change state, because it has to be remembered for idempotency and for
 * future replays. Every other refusal leaves state untouched.
 */
export function applyScan(
  state: RouteRunState,
  event: ScanEvent,
  options: ApplyScanOptions,
): ApplyOutcome {
  const debounceMs = options.debounceWindowMs ?? DEBOUNCE_WINDOW_MS;

  // The reader -> bus map produced `busId`; a mismatch means this event was
  // routed to the wrong run and must not touch it. This is NOT wrong-bus
  // (D-005), which is about the *student's* assignment, not the reader's.
  if (event.busId !== state.busId) {
    return unapplied(state, 'unknown_reader');
  }

  // A rejected credential never boards anybody (D-009). This is a safety case,
  // not a bookkeeping one: the student's card did not open the door, so there
  // is no validated boarding and they must not appear aboard. Checked before
  // everything except the routing guard, because no downstream question about
  // this event can change the answer. It is recorded upstream as a raw event —
  // "a rejected tap at the door is a student who tried" — but it stays out of
  // this run's log, so a redelivery answers `credential_rejected` again rather
  // than `duplicate_event`.
  if (!event.accepted) {
    return unapplied(state, 'credential_rejected');
  }

  // Idempotency, so replaying a delivery is a no-op whatever else is true.
  if (state.log.some((entry) => entry.eventId === event.eventId)) {
    return unapplied(state, 'duplicate_event');
  }

  // A closed run is history. See closeRouteRun in reconcile.ts.
  if (state.closedAt !== undefined) {
    return unapplied(state, 'stale_event');
  }

  // Unparseable timestamps cannot be ordered, and ordering is the whole game.
  // The webhook's schema validation is the real guard; this is belt-and-braces.
  // (The contract has no `malformed_event` reason — see the note in index.ts.)
  if (Number.isNaN(Date.parse(event.occurredAt))) {
    return unapplied(state, 'stale_event');
  }

  // No user id means the credential matched no Verkada access user, so there is
  // nobody to move. Same outcome as a roster miss.
  if (event.verkadaUserId === undefined) {
    return unapplied(state, 'unknown_user');
  }

  const assignment = options.lookupUser(event.verkadaUserId);
  if (assignment === undefined) {
    // Recorded upstream as a raw event; it just cannot move a student.
    return unapplied(state, 'unknown_user');
  }

  const wrongBus = assignment.assignedBusId !== event.busId;

  const inserted: LoggedScan = {
    eventId: event.eventId,
    studentId: assignment.studentId,
    verkadaUserId: event.verkadaUserId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    // direction/source/contradiction are all replaced by the replay below.
    direction: null,
    directionSource: 'derived',
    contradictsDerived: false,
    wrongBus,
    ...(event.cardId !== undefined ? { cardId: event.cardId } : {}),
    ...(event.deviceDirection !== undefined
      ? { reportedDirection: event.deviceDirection }
      : {}),
  };

  const projected = project([...state.log, inserted], debounceMs);
  const applied = projected.log.find((entry) => entry.eventId === event.eventId);

  // `find` cannot miss (we just inserted it), but strict mode wants the branch.
  const direction = applied?.direction ?? null;
  const directionSource = applied?.directionSource ?? 'derived';

  const alerts: Alert[] = [];
  const wrongBusAlerted = [...state.wrongBusAlerted];

  // Wrong-bus is raised for whichever of this student's log entries is *now* a
  // boarding — including an older event that this late arrival just flipped
  // from 'off' to 'on'. Only this student's directions can have changed, since
  // replay is per-student. One alert per student per run: re-boarding the same
  // wrong bus mid-route is not news, and alert fatigue is how real alerts get
  // ignored.
  if (wrongBus && !wrongBusAlerted.includes(assignment.studentId)) {
    const boarding = projected.log.find(
      (entry) => entry.studentId === assignment.studentId && entry.direction === 'on',
    );
    if (boarding !== undefined) {
      wrongBusAlerted.push(assignment.studentId);
      alerts.push({
        kind: 'wrong_bus',
        studentId: assignment.studentId,
        busId: state.busId,
        routeRunId: state.routeRunId,
        raisedAt: event.receivedAt,
        triggeringEventId: boarding.eventId,
        // No names: hard rule, no full student records in logs or messages.
        detail: `Student ${assignment.studentId} boarded bus ${state.busId} but is assigned to bus ${assignment.assignedBusId}.`,
      });
    }
  }

  const nextState: RouteRunState = {
    ...state,
    log: projected.log,
    aboard: projected.aboard,
    updatedAt: event.receivedAt,
    wrongBusAlerted,
    // Any change to the log invalidates a prior reconciliation.
    reconciliationStale: state.reconciledAt !== undefined,
  };

  if (direction === null) {
    // Debounced: a second tap seconds after the first is the same tap. Only the
    // derived path can land here. State still advanced (the event is in the
    // log), which is why this returns `nextState` rather than `state`.
    return { state: nextState, result: { applied: false, reason: 'debounced', alerts: [] } };
  }

  const scan: ResolvedScan = {
    ...event,
    studentId: assignment.studentId,
    direction,
    directionSource,
  };

  return { state: nextState, result: { applied: true, scan, alerts } };
}

/** Contract-shaped live manifest for the portal. */
export function toManifest(state: RouteRunState): BusManifest {
  return {
    busId: state.busId,
    routeRunId: state.routeRunId,
    aboard: [...state.aboard],
    updatedAt: state.updatedAt,
  };
}

export function isAboard(state: RouteRunState, studentId: StudentId): boolean {
  return state.aboard.some((entry) => entry.studentId === studentId);
}

/** The direction currently resolved for an event, or `undefined` if unknown. */
export function directionOf(
  state: RouteRunState,
  eventId: string,
): ScanDirection | null | undefined {
  return state.log.find((entry) => entry.eventId === eventId)?.direction;
}

/** How that direction was established, or `undefined` if the event is unknown. */
export function directionSourceOf(
  state: RouteRunState,
  eventId: string,
): DirectionSource | undefined {
  return state.log.find((entry) => entry.eventId === eventId)?.directionSource;
}

/**
 * Scans where the door reported a direction that contradicts what this module
 * would have derived. Reported won in every case; these are for review, not for
 * correction. Empty for a run where the two agree (or where nothing reports).
 */
export function directionContradictions(state: RouteRunState): readonly LoggedScan[] {
  return state.log.filter((entry) => entry.contradictsDerived);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function unapplied(state: RouteRunState, reason: RejectionReason): ApplyOutcome {
  return { state, result: { applied: false, reason, alerts: [] } };
}

interface StudentProjection {
  aboard: boolean;
  lastAcceptedMs: number;
  entry: ManifestEntry | null;
}

/**
 * Replay the log in `occurredAt` order, resolving direction per the revised
 * D-002 (reported wins, derived falls back, debounce guards derivation only).
 * Ties on `occurredAt` break on `eventId` so the result is a pure function of
 * the set of events, independent of arrival order.
 */
function project(
  entries: readonly LoggedScan[],
  debounceMs: number,
): { log: readonly LoggedScan[]; aboard: readonly ManifestEntry[] } {
  const ordered = entries
    .map((entry) => ({ entry, ms: Date.parse(entry.occurredAt) }))
    .sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : compareIds(a.entry.eventId, b.entry.eventId)));

  const students = new Map<StudentId, StudentProjection>();
  const log: LoggedScan[] = [];

  for (const { entry, ms } of ordered) {
    let projection = students.get(entry.studentId);
    if (projection === undefined) {
      projection = { aboard: false, lastAcceptedMs: Number.NEGATIVE_INFINITY, entry: null };
      students.set(entry.studentId, projection);
    }

    // What derivation alone would have said. Also the yardstick a reported
    // direction is checked against.
    const derived: ScanDirection = projection.aboard ? 'off' : 'on';

    let direction: ScanDirection | null;
    let directionSource: DirectionSource;
    let contradictsDerived = false;

    if (entry.reportedDirection !== undefined) {
      // In/Out Door: the hardware knows. No debounce — two reported Inbounds
      // seconds apart are two boardings, not a boarding and an accidental exit.
      direction = entry.reportedDirection === 'Inbound' ? 'on' : 'off';
      directionSource = 'device';
      contradictsDerived = direction !== derived;
    } else {
      directionSource = 'derived';
      // Window runs from the last *accepted* tap of either kind: a derived tap
      // moments after a device tap is still the same physical tap.
      direction = ms - projection.lastAcceptedMs < debounceMs ? null : derived;
    }

    if (direction !== null) {
      // Assign, do not toggle: a reported direction can restate the current
      // state (Inbound while already aboard) and must not flip it.
      projection.aboard = direction === 'on';
      projection.lastAcceptedMs = ms;
      projection.entry =
        direction === 'on'
          ? {
              studentId: entry.studentId,
              boardedAt: entry.occurredAt,
              boardingEventId: entry.eventId,
              wrongBus: entry.wrongBus,
            }
          : null;
    }

    log.push({ ...entry, direction, directionSource, contradictsDerived });
  }

  const aboard: ManifestEntry[] = [];
  for (const projection of students.values()) {
    if (projection.entry !== null) aboard.push(projection.entry);
  }
  aboard.sort((a, b) =>
    a.boardedAt !== b.boardedAt
      ? compareIds(a.boardedAt, b.boardedAt)
      : compareIds(a.studentId, b.studentId),
  );

  return { log, aboard };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
