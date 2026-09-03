/**
 * PILOT SCAFFOLDING — in-memory route-run store and roster.
 *
 * This exists so the tap → manifest pipeline can be exercised end to end with
 * the mock generator before the Postgres repository is written. The schema in
 * `middleware/db/` is the real target; this file is what stands in for it until
 * issue #2's persistence half lands.
 *
 * Deliberate limitations, so nobody mistakes this for the real thing:
 *  - state dies with the process, so a restart mid-route loses the manifest
 *  - single-process only; two instances would each hold a different truth
 *  - no point-in-time roster resolution (D-007's `resolve_student_at`)
 *
 * The never-scanned-off safeguard is only as durable as the state behind it, so
 * this must NOT reach a bus carrying real students.
 */

import {
  applyScan,
  createRouteRunState,
  type ApplyOutcome,
  type RosterLookup,
  type RouteRunState,
} from '../boarding/index.js';
import type {
  ApplyResult,
  BusId,
  RouteId,
  ScanEvent,
  StopId,
  StudentAssignment,
  StudentId,
  VerkadaUserId,
} from '../types/events.js';

/** One roster row as exported by `SEED_ROSTER_OUT=… npm run seed`. */
export interface RosterFileEntry {
  studentId: string;
  verkadaUserId: string;
  firstName?: string;
  lastName?: string;
  grade?: string;
  assignedBusId?: string;
  assignedRouteId?: string;
  assignedStopId?: string;
}

export function rosterFromEntries(entries: readonly RosterFileEntry[]): {
  lookup: RosterLookup;
  size: number;
} {
  const byUser = new Map<string, StudentAssignment>();
  for (const e of entries) {
    // Only `assignedBusId` is required (D-013). Route/stop/name are optional
    // display metadata — requiring them here silently emptied the whole roster
    // once, because the seed export does not carry a stop id.
    if (!e.assignedBusId) continue;
    byUser.set(e.verkadaUserId, {
      studentId: e.studentId as StudentId,
      verkadaUserId: e.verkadaUserId as VerkadaUserId,
      assignedBusId: e.assignedBusId as BusId,
      ...(e.firstName === undefined ? {} : { firstName: e.firstName }),
      ...(e.lastName === undefined ? {} : { lastName: e.lastName }),
      ...(e.grade === undefined ? {} : { grade: e.grade }),
      ...(e.assignedRouteId === undefined ? {} : { assignedRouteId: e.assignedRouteId as RouteId }),
      ...(e.assignedStopId === undefined ? {} : { assignedStopId: e.assignedStopId as StopId }),
    });
  }
  return { lookup: (userId) => byUser.get(userId), size: byUser.size };
}

export interface StoreOptions {
  lookupUser: RosterLookup;
  /** Names the current run for a bus. Default: one run per bus per calendar day. */
  routeRunIdFor?: (busId: BusId, at: Date) => string;
}

/**
 * Holds one `RouteRunState` per bus and funnels every scan through the boarding
 * state machine. Applies are serialized per bus: the state machine is pure and
 * returns new state, so two concurrent taps on one bus would otherwise race and
 * the second would overwrite the first — dropping a child from the manifest.
 */
export class MemoryRouteRunStore {
  readonly #runs = new Map<string, RouteRunState>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #options: StoreOptions;

  constructor(options: StoreOptions) {
    this.#options = options;
  }

  #runIdFor(busId: BusId, at: Date): string {
    if (this.#options.routeRunIdFor) return this.#options.routeRunIdFor(busId, at);
    return `${busId}-${at.toISOString().slice(0, 10)}`;
  }

  /** Serialize work per bus so concurrent deliveries cannot clobber each other. */
  #serialize<T>(busId: BusId, work: () => T): Promise<T> {
    const prior = this.#queues.get(busId) ?? Promise.resolve();
    const next = prior.then(work, work);
    this.#queues.set(
      busId,
      next.catch(() => undefined),
    );
    return next;
  }

  async apply(event: ScanEvent): Promise<ApplyResult> {
    return this.#serialize(event.busId, () => {
      const runId = this.#runIdFor(event.busId, new Date(event.occurredAt));
      const existing =
        this.#runs.get(runId) ??
        createRouteRunState({
          busId: event.busId,
          routeRunId: runId,
          startedAt: event.occurredAt,
        });
      const outcome: ApplyOutcome = applyScan(existing, event, {
        lookupUser: this.#options.lookupUser,
      });
      // Persist state unconditionally — a debounced tap advances state while
      // reporting applied:false, so gating this on `applied` loses information.
      this.#runs.set(runId, outcome.state);
      return outcome.result;
    });
  }

  get(routeRunId: string): RouteRunState | undefined {
    return this.#runs.get(routeRunId);
  }

  currentRunFor(busId: BusId, at: Date = new Date()): RouteRunState | undefined {
    return this.#runs.get(this.#runIdFor(busId, at));
  }

  all(): readonly RouteRunState[] {
    return [...this.#runs.values()];
  }
}
