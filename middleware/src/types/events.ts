/**
 * SHARED CONTRACT — every other module builds against these types.
 *
 * Do not add Verkada wire-format fields here. Verkada's raw payload shape is
 * known only to `middleware/src/webhook/normalize.ts`, which maps it to
 * `ScanEvent`. That adapter is the single place that changes if the Verkada
 * webhook schema changes.
 *
 * Modelled against the real Access Events Webhook docs (retrieved 2026-09-02):
 * https://apidocs.verkada.com/reference/access-events-webhooks
 *
 * Changes to this file must be logged in docs/decisions.md.
 */

/** Opaque branded IDs so a busId can never be passed where a studentId belongs. */
export type StudentId = string & { readonly __brand: 'StudentId' };
export type BusId = string & { readonly __brand: 'BusId' };
export type RouteId = string & { readonly __brand: 'RouteId' };
export type StopId = string & { readonly __brand: 'StopId' };
/** Verkada's user_id for the student's access user. Primary identity key (D-007). */
export type VerkadaUserId = string & { readonly __brand: 'VerkadaUserId' };
/** Raw credential value from `input_value`. Format varies by event type — see D-007. */
export type CardId = string & { readonly __brand: 'CardId' };

/**
 * Verkada reports direction only when the door is configured as an In/Out Door;
 * otherwise the field is null and direction must be derived (D-002).
 */
export type DeviceDirection = 'Inbound' | 'Outbound';

/**
 * A single card tap, normalized.
 *
 * NOTE what is NOT here: the Verkada access webhook carries no GPS and no video
 * clip reference (D-008). Those are enrichment fetched separately from Command
 * and attached later — never expect them on the inbound event.
 */
export interface ScanEvent {
  /** Verkada `data.event_id`. Idempotency key — never apply the same id twice. */
  eventId: string;
  /**
   * Verkada `data.user_info.user_id`. Present on accepted credential events.
   * Absent when the credential matched no user (a rejected/unknown card).
   */
  verkadaUserId?: VerkadaUserId;
  /** Verkada `data.input_value`. Retained for audit; NOT the primary key (D-007). */
  cardId?: CardId;
  /** Verkada `data.device_id` — the access control object that produced the tap. */
  deviceId: string;
  /** Verkada `data.door_id`. Null on ACU-level events. */
  doorId?: string;
  /** Resolved from deviceId/doorId via the reader map. */
  busId: BusId;
  /** Verkada `data.notification_type`, e.g. door_keycard_entered_accepted. */
  notificationType: string;
  /** True for `*_accepted` types. A rejected tap is recorded, never boards (D-009). */
  accepted: boolean;
  /**
   * Verkada `data.direction`, when the door is an In/Out Door. Authoritative when
   * present — the state machine prefers it over derivation (D-002).
   */
  deviceDirection?: DeviceDirection;
  /** From Verkada `data.created` (epoch seconds). Source of truth for ordering (D-003). */
  occurredAt: string;
  /** When the middleware received it. May lag occurredAt badly on cellular. */
  receivedAt: string;
}

/**
 * Enrichment attached after the fact by querying Command. Kept off ScanEvent so
 * nothing in the hot path waits on it (the webhook must answer in <2000ms, D-010).
 */
export interface ScanEnrichment {
  eventId: string;
  gps?: { lat: number; lon: number; accuracyM?: number };
  /** Command footage link or thumbnail reference for the door camera. */
  clipRef?: string;
}

export type ScanDirection = 'on' | 'off';

/** How direction was established, so the portal can show confidence. */
export type DirectionSource = 'device' | 'derived';

/** A tap after direction has been established and the credential resolved. */
export interface ResolvedScan extends ScanEvent {
  studentId: StudentId;
  direction: ScanDirection;
  directionSource: DirectionSource;
}

/**
 * Roster facts the boarding logic needs. Storage-agnostic on purpose.
 *
 * Only `assignedBusId` is load-bearing — it is the wrong-bus comparison (D-005).
 * Route, stop, name and grade are manifest-display metadata from the district
 * SIS and are optional, because a roster source may not carry them and boarding
 * must not fail when it doesn't (D-013).
 */
export interface StudentAssignment {
  studentId: StudentId;
  verkadaUserId: VerkadaUserId;
  assignedBusId: BusId;
  firstName?: string;
  lastName?: string;
  grade?: string;
  assignedRouteId?: RouteId;
  assignedStopId?: StopId;
}

/** One student currently aboard a bus. */
export interface ManifestEntry {
  studentId: StudentId;
  boardedAt: string;
  boardingEventId: string;
  clipRef?: string;
  /** True when assignedBusId !== the bus they actually boarded. */
  wrongBus: boolean;
}

/** Live state for one bus on one route run. */
export interface BusManifest {
  busId: BusId;
  routeRunId: string;
  aboard: ManifestEntry[];
  updatedAt: string;
}

export type AlertKind = 'wrong_bus' | 'never_scanned_off';

export interface Alert {
  kind: AlertKind;
  studentId: StudentId;
  busId: BusId;
  routeRunId: string;
  raisedAt: string;
  /** Event that triggered it. Absent for reconciliation alerts (nothing happened). */
  triggeringEventId?: string;
  detail: string;
}

/**
 * Reasons an event is accepted but not applied to state. Never throw these —
 * the webhook must still 200 so Verkada does not retry forever (D-004).
 */
export type RejectionReason =
  | 'unknown_user'
  | 'unknown_reader'
  | 'duplicate_event'
  | 'debounced'
  | 'credential_rejected'
  | 'stale_event'
  | 'not_a_scan_event';

export interface ApplyResult {
  applied: boolean;
  reason?: RejectionReason;
  scan?: ResolvedScan;
  alerts: Alert[];
}
