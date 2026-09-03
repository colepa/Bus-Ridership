-- 002_operations.sql
-- Operational tables: the append-only tap log, the asynchronous enrichment that
-- hangs off it, the run that reconciliation closes over, live boarding state,
-- and alerts.
--
-- Designed against the real Verkada Access Events webhook payload
-- (docs/decisions.md D-006..D-012).

-- ---------------------------------------------------------------------------
-- route_runs
-- ---------------------------------------------------------------------------
--
-- One execution of a route on a calendar day (AM pickup / PM dropoff). This is
-- the unit end-of-route reconciliation closes over: closing a run means every
-- boarding still open on it becomes a never_scanned_off alert.
--
-- service_date is a bare `date` on purpose: it is a calendar day for the
-- district, not an instant. Every actual instant on this table is timestamptz.

CREATE TABLE route_runs (
  route_run_id  text        PRIMARY KEY,
  route_id      text        NOT NULL REFERENCES routes (route_id) ON DELETE RESTRICT,
  bus_id        text        NOT NULL REFERENCES buses  (bus_id)  ON DELETE RESTRICT,
  service_date  date        NOT NULL,
  session       text        NOT NULL CHECK (session IN ('am', 'pm')),
  status        text        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'reconciling', 'closed')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  -- Set when reconciliation has run to completion for this run.
  reconciled_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_runs_period_ordered CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT route_runs_closed_has_end  CHECK (status <> 'closed' OR ended_at IS NOT NULL)
);

CREATE UNIQUE INDEX uq_route_runs_natural ON route_runs (route_id, service_date, session);

-- "Which run is this tap part of" — hot path on every event.
CREATE INDEX idx_route_runs_bus_open ON route_runs (bus_id, started_at DESC)
  WHERE status <> 'closed';
CREATE INDEX idx_route_runs_date ON route_runs (service_date DESC, route_id);

CREATE TRIGGER trg_route_runs_updated_at
  BEFORE UPDATE ON route_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- PII redaction for stored raw payloads (D-012)
-- ---------------------------------------------------------------------------
--
-- Verkada puts the student's name, email and phone inside `data.user_info` on
-- EVERY access event. D-012 says only `user_id` may survive. `normalize.ts`
-- drops the rest at the adapter boundary, but a convention that lives in one
-- TypeScript file is one careless `JSON.stringify(body)` away from failing, and
-- the forensics column is exactly where a careless writer would put the whole
-- body. So the database enforces it itself, twice:
--
--   1. redact_verkada_payload() rewrites the payload on the way in (trigger).
--      Whatever the application sends, what lands on disk is redacted.
--   2. a CHECK constraint asserts the invariant declaratively, so the row is
--      still rejected if triggers are bypassed (session_replication_role =
--      'replica' disables triggers; it does not disable CHECK constraints).
--
-- The redactor walks the whole document, so a `user_info` nested anywhere —
-- today it is at `data.user_info` — is caught, not just the documented path.

CREATE OR REPLACE FUNCTION redact_verkada_payload(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k   text;
  v   jsonb;
  acc jsonb;
BEGIN
  IF payload IS NULL THEN
    RETURN NULL;
  END IF;

  CASE jsonb_typeof(payload)
    WHEN 'object' THEN
      acc := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(payload) LOOP
        IF k = 'user_info' THEN
          -- Keep the identity key and nothing else. A non-object user_info
          -- cannot be reduced safely, so it becomes null rather than leaking.
          IF jsonb_typeof(v) = 'object' AND v ? 'user_id' THEN
            acc := acc || jsonb_build_object('user_info',
                                             jsonb_build_object('user_id', v -> 'user_id'));
          ELSE
            acc := acc || jsonb_build_object('user_info', 'null'::jsonb);
          END IF;
        ELSE
          acc := acc || jsonb_build_object(k, redact_verkada_payload(v));
        END IF;
      END LOOP;
      RETURN acc;

    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(redact_verkada_payload(t.e)), '[]'::jsonb)
        INTO acc
        FROM jsonb_array_elements(payload) AS t(e);
      RETURN acc;

    ELSE
      RETURN payload;
  END CASE;
END;
$$;

COMMENT ON FUNCTION redact_verkada_payload(jsonb) IS
  'D-012: reduces every user_info object in a Verkada payload to {user_id}. Idempotent.';

-- "Redacted" is defined as "redacting again changes nothing" — one definition,
-- so the CHECK and the trigger can never drift apart.
CREATE OR REPLACE FUNCTION verkada_payload_is_redacted(payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT redact_verkada_payload(payload) IS NOT DISTINCT FROM payload;
$$;

-- ---------------------------------------------------------------------------
-- scan_events  (append-only log of every notification)
-- ---------------------------------------------------------------------------
--
-- Mirrors ScanEvent in middleware/src/types/events.ts, plus the resolution
-- outcome. Every notification Verkada sends lands here, including ones that are
-- accepted-but-not-applied (D-004): unknown user, unknown reader, duplicate,
-- stale, debounced, rejected credential, or simply not a scan event at all.
--
-- That is why verkada_user_id, input_value, device_id and door_id carry no
-- foreign keys, and bus_id / student_id / route_run_id are nullable — an
-- unresolvable event must still be recorded verbatim for forensics.
--
-- input_value is audit data ONLY (D-007). Its format varies by event type
-- ("109|35302" on an accepted keycard, a 40-bit binary string on rejected/NFC,
-- a UUID on face), so it is never a join key. verkada_user_id is the identity.
--
-- What is NOT here: GPS and clip_ref. The access webhook carries neither
-- (D-008); they live in scan_enrichment, fetched from Command afterwards.
--
-- event_id is the primary key, which *is* the idempotency guarantee from
-- D-001/D-004: insert with ON CONFLICT (event_id) DO NOTHING and a replayed
-- event can never be applied twice.

CREATE TABLE scan_events (
  event_id      text        PRIMARY KEY,
  -- Monotonic arrival counter. Tie-breaker only; ordering is by occurred_at.
  seq           bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,

  -- Identity (D-007). Null when the credential matched no Verkada user.
  verkada_user_id text,
  -- Verbatim `data.input_value`. Audit/provenance only — NOT a foreign key.
  input_value   text,

  -- Where it happened. `data.device_id` is always present; `data.door_id` is
  -- null on ACU-level events. Resolved to bus_id via the readers map.
  device_id     text        NOT NULL,
  door_id       text,
  bus_id        text        REFERENCES buses (bus_id) ON DELETE RESTRICT,

  -- What kind of notification it was. The discriminator is
  -- `data.notification_type`, not the envelope's webhook_type (D-006).
  notification_type text    NOT NULL,
  -- True for `*_accepted` types. A rejected tap is recorded, never boards (D-009).
  accepted      boolean     NOT NULL,

  -- `data.direction`, populated only when the door is an In/Out Door (D-002).
  device_direction text     CHECK (device_direction IN ('Inbound', 'Outbound')),

  -- D-003: occurred_at (from `data.created`, epoch seconds) orders events;
  -- received_at is wall-clock arrival and may lag by minutes on a buffering
  -- cellular gateway.
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),

  -- Resolution outcome. Null until/unless the event resolved.
  student_id    text        REFERENCES students   (student_id)   ON DELETE RESTRICT,
  route_run_id  text        REFERENCES route_runs (route_run_id) ON DELETE RESTRICT,
  direction     text        CHECK (direction IN ('on', 'off')),
  -- Which path established `direction` — reported by the door, or derived from
  -- state. Mirrors ResolvedScan.directionSource so the portal can show it.
  direction_source text     CHECK (direction_source IN ('device', 'derived')),
  applied       boolean     NOT NULL DEFAULT false,
  rejection_reason text     CHECK (rejection_reason IN (
                              'unknown_user',
                              'unknown_reader',
                              'duplicate_event',
                              'debounced',
                              'credential_rejected',
                              'stale_event',
                              'not_a_scan_event'
                            )),

  -- Verbatim Verkada payload, MINUS the PII. The normalizer owns the wire
  -- format (D-001); this column keeps the original for forensics. `user_info`
  -- is reduced to `{user_id}` on the way in and the reduction is enforced by
  -- both the constraint below and trg_scan_events_a_redact_pii (D-012).
  raw           jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- D-012, declarative half. Belt to the trigger's braces: this still fires if
  -- triggers are disabled for the session.
  CONSTRAINT scan_events_raw_pii_redacted CHECK (verkada_payload_is_redacted(raw)),

  -- An applied event is a resolved event, and vice versa.
  CONSTRAINT scan_events_applied_not_rejected
    CHECK (NOT (applied AND rejection_reason IS NOT NULL)),
  CONSTRAINT scan_events_applied_is_resolved
    CHECK (NOT applied OR (verkada_user_id IS NOT NULL
                           AND student_id IS NOT NULL
                           AND bus_id IS NOT NULL
                           AND route_run_id IS NOT NULL
                           AND direction IS NOT NULL)),
  -- D-009: a rejected credential is recorded but never changes state.
  CONSTRAINT scan_events_applied_requires_accepted
    CHECK (NOT applied OR accepted),
  CONSTRAINT scan_events_rejected_reason_matches_accepted
    CHECK (rejection_reason IS DISTINCT FROM 'credential_rejected' OR NOT accepted),
  -- direction and its provenance travel together (ResolvedScan has both).
  CONSTRAINT scan_events_direction_source_together
    CHECK ((direction IS NULL) = (direction_source IS NULL)),
  -- D-002: 'device' provenance is only claimable when the door actually
  -- reported a direction.
  CONSTRAINT scan_events_device_source_needs_device_direction
    CHECK (direction_source IS DISTINCT FROM 'device' OR device_direction IS NOT NULL)
);

-- Hot query: current manifest / recent activity for a bus.
CREATE INDEX idx_scan_events_bus_occurred ON scan_events (bus_id, occurred_at DESC);
-- Hot query: ride history for a student over a date range.
CREATE INDEX idx_scan_events_student_occurred ON scan_events (student_id, occurred_at DESC)
  WHERE student_id IS NOT NULL;
-- Hot query: everything that happened on one route run, in tap order.
CREATE INDEX idx_scan_events_run_occurred ON scan_events (route_run_id, occurred_at)
  WHERE route_run_id IS NOT NULL;
-- Hot query: D-002 debounce — "did this user tap in the last N seconds".
-- Keyed on the identity (D-007), not on input_value, which is not stable.
CREATE INDEX idx_scan_events_user_occurred ON scan_events (verkada_user_id, occurred_at DESC)
  WHERE verkada_user_id IS NOT NULL;
-- Late-arrival / backlog triage: how far behind is the gateway.
CREATE INDEX idx_scan_events_received ON scan_events (received_at DESC);
-- Triage of dropped events.
CREATE INDEX idx_scan_events_rejected ON scan_events (rejection_reason, occurred_at DESC)
  WHERE rejection_reason IS NOT NULL;
-- Triage of non-scan traffic (door held open, tamper, ...) by type.
CREATE INDEX idx_scan_events_notification_type ON scan_events (notification_type, occurred_at DESC);
-- Audit: "which taps carried this credential value". Deliberately a plain
-- index, not a foreign key — see D-007.
CREATE INDEX idx_scan_events_input_value ON scan_events (input_value, occurred_at DESC)
  WHERE input_value IS NOT NULL;

-- The composite target that lets `boardings` prove, declaratively, that the
-- event behind a manifest row was accepted (D-009). event_id is already the
-- primary key, so this index is redundant for uniqueness — it exists purely so
-- a foreign key can reference (event_id, accepted).
CREATE UNIQUE INDEX uq_scan_events_event_accepted ON scan_events (event_id, accepted);

COMMENT ON TABLE scan_events IS
  'Append-only. Every notification Verkada delivers, applied or not. event_id is the Verkada idempotency key (D-001/D-004).';
COMMENT ON COLUMN scan_events.verkada_user_id IS 'user_info.user_id. The identity key (D-007). Null when no user matched.';
COMMENT ON COLUMN scan_events.input_value IS 'data.input_value verbatim. Audit only — format varies by event type, never a join key (D-007).';
COMMENT ON COLUMN scan_events.occurred_at IS 'On-bus tap time, from data.created (epoch seconds). Source of truth for ordering (D-003).';
COMMENT ON COLUMN scan_events.received_at IS 'Middleware arrival time. May lag occurred_at badly (D-003).';
COMMENT ON COLUMN scan_events.raw IS 'Verkada payload with user_info reduced to {user_id}. Enforced by trigger AND check constraint (D-012).';

-- D-012, imperative half: rewrite on the way in so the application physically
-- cannot store PII here, whatever it sends.
CREATE OR REPLACE FUNCTION scan_events_redact_pii() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.raw := redact_verkada_payload(coalesce(NEW.raw, '{}'::jsonb));
  RETURN NEW;
END;
$$;

-- NAMING IS LOAD-BEARING: same-event triggers fire in name order, and the
-- redactor must run before the append-only guard, or an UPDATE would compare an
-- unredacted NEW.raw against a redacted OLD.raw and spuriously fail.
-- Hence `_a_` and `_b_`.
CREATE TRIGGER trg_scan_events_a_redact_pii
  BEFORE INSERT OR UPDATE ON scan_events
  FOR EACH ROW EXECUTE FUNCTION scan_events_redact_pii();

-- Append-only enforcement. Resolution columns are filled in as the pipeline
-- processes the event, so updates are allowed — but the recorded facts of the
-- tap are frozen, and nothing may be deleted.
CREATE OR REPLACE FUNCTION scan_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scan_events is append-only: DELETE not permitted (event_id=%)', OLD.event_id;
  END IF;

  IF NEW.event_id          IS DISTINCT FROM OLD.event_id
     OR NEW.verkada_user_id   IS DISTINCT FROM OLD.verkada_user_id
     OR NEW.input_value       IS DISTINCT FROM OLD.input_value
     OR NEW.device_id         IS DISTINCT FROM OLD.device_id
     OR NEW.door_id           IS DISTINCT FROM OLD.door_id
     OR NEW.notification_type IS DISTINCT FROM OLD.notification_type
     OR NEW.accepted          IS DISTINCT FROM OLD.accepted
     OR NEW.device_direction  IS DISTINCT FROM OLD.device_direction
     OR NEW.occurred_at       IS DISTINCT FROM OLD.occurred_at
     OR NEW.received_at       IS DISTINCT FROM OLD.received_at
     OR NEW.raw               IS DISTINCT FROM OLD.raw
  THEN
    RAISE EXCEPTION 'scan_events is append-only: immutable column changed (event_id=%)', OLD.event_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_scan_events_b_append_only
  BEFORE UPDATE OR DELETE ON scan_events
  FOR EACH ROW EXECUTE FUNCTION scan_events_append_only();

-- ---------------------------------------------------------------------------
-- scan_enrichment  (GPS + video, fetched from Command after the fact)
-- ---------------------------------------------------------------------------
--
-- D-008: the access webhook carries no GPS and no clip reference. Both are
-- enrichment, queried from Command off the response path (the webhook must
-- answer in under 2000 ms, D-010).
--
-- Its own table, keyed 1:1 on event_id, so that:
--   * a scan row is never half-empty waiting on an async fetch — the absence of
--     a row here is the honest representation of "not enriched yet";
--   * a failed or slow enrichment cannot block, corrupt, or partially update
--     the tap record, which is the legally interesting one;
--   * retry bookkeeping (attempts, last_error) lives with the thing being
--     retried instead of polluting the append-only log.
--
-- Mirrors ScanEnrichment in middleware/src/types/events.ts.

CREATE TABLE scan_enrichment (
  event_id        text        PRIMARY KEY REFERENCES scan_events (event_id) ON DELETE RESTRICT,

  gps_lat         double precision CHECK (gps_lat BETWEEN -90 AND 90),
  gps_lon         double precision CHECK (gps_lon BETWEEN -180 AND 180),
  gps_accuracy_m  double precision CHECK (gps_accuracy_m >= 0),
  -- Command footage link or thumbnail reference for the door camera.
  clip_ref        text,

  -- Fetch bookkeeping. 'pending' rows are claimable work; 'failed' rows are
  -- triage. Nothing here ever propagates back into scan_events.
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'ok', 'unavailable', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_error      text,
  fetched_at      timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scan_enrichment_gps_together CHECK ((gps_lat IS NULL) = (gps_lon IS NULL)),
  CONSTRAINT scan_enrichment_accuracy_needs_fix
    CHECK (gps_accuracy_m IS NULL OR gps_lat IS NOT NULL),
  CONSTRAINT scan_enrichment_ok_has_payload
    CHECK (status <> 'ok' OR (fetched_at IS NOT NULL
                              AND (gps_lat IS NOT NULL OR clip_ref IS NOT NULL))),
  CONSTRAINT scan_enrichment_error_only_when_failed
    CHECK (last_error IS NULL OR status = 'failed')
);

-- The enrichment worker's queue scan.
CREATE INDEX idx_scan_enrichment_pending ON scan_enrichment (created_at)
  WHERE status = 'pending';
CREATE INDEX idx_scan_enrichment_failed ON scan_enrichment (last_attempt_at DESC)
  WHERE status = 'failed';

CREATE TRIGGER trg_scan_enrichment_updated_at
  BEFORE UPDATE ON scan_enrichment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE scan_enrichment IS
  'GPS and clip_ref for a tap, fetched from Command after the fact (D-008). Absent row = not enriched. Never on the webhook response path (D-010).';

-- ---------------------------------------------------------------------------
-- boardings  (manifest / boarding state)
-- ---------------------------------------------------------------------------
--
-- One row per ride. Open row (exited_at IS NULL) == currently aboard, which
-- makes this table both the live manifest and the ride history:
--
--   live manifest for a bus   : WHERE bus_id = $1 AND exited_at IS NULL
--   open records for a run    : WHERE route_run_id = $1 AND exited_at IS NULL
--   ride history for a student: WHERE student_id = $1 AND boarded_at BETWEEN ...
--
-- D-005: wrong_bus is a flag on the boarding, never a reason to skip the row.
--
-- D-009 IS ENFORCED STRUCTURALLY HERE. A rejected credential is recorded in
-- scan_events but must never move a student onto or off a manifest, and that
-- must not depend on application code remembering to check. The mechanism:
-- `boarding_event_accepted` is pinned to true by a CHECK, and the composite
-- foreign key (boarding_event_id, boarding_event_accepted) can therefore only
-- resolve to a scan_events row whose `accepted` is true. Citing an
-- accepted = false event as a boarding is a foreign key violation, at any
-- isolation level, from any client, including psql. The exit side works the
-- same way, with the two columns tied null-together so MATCH SIMPLE means
-- "no exit yet" rather than "unchecked".

CREATE TABLE boardings (
  boarding_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_run_id       text        NOT NULL REFERENCES route_runs (route_run_id) ON DELETE RESTRICT,
  bus_id             text        NOT NULL REFERENCES buses    (bus_id)     ON DELETE RESTRICT,
  student_id         text        NOT NULL REFERENCES students (student_id) ON DELETE RESTRICT,

  boarded_at         timestamptz NOT NULL,
  boarding_event_id  text        NOT NULL,
  -- Always true; exists only as the second leg of the composite FK below.
  boarding_event_accepted boolean NOT NULL DEFAULT true,
  boarding_stop_id   text        REFERENCES stops (stop_id) ON DELETE SET NULL,

  exited_at          timestamptz,
  exit_event_id      text,
  -- True when present, NULL when there is no exit yet. Same trick as above.
  exit_event_accepted boolean,
  exit_stop_id       text        REFERENCES stops (stop_id) ON DELETE SET NULL,

  -- True when the student's assigned bus at boarding time was not bus_id (D-005).
  wrong_bus          boolean     NOT NULL DEFAULT false,
  -- How the ride ended. 'scan_off' = normal tap; 'reconciliation' = force-closed
  -- at end of route with a never_scanned_off alert; 'manual' = staff override.
  closed_reason      text        CHECK (closed_reason IN ('scan_off', 'reconciliation', 'manual')),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- D-009: only an accepted credential event can put a student on a manifest.
  CONSTRAINT boardings_boarding_event_must_be_accepted CHECK (boarding_event_accepted),
  CONSTRAINT boardings_exit_event_must_be_accepted
    CHECK (exit_event_accepted IS NULL OR exit_event_accepted),
  CONSTRAINT boardings_exit_event_flag_together
    CHECK ((exit_event_id IS NULL) = (exit_event_accepted IS NULL)),
  CONSTRAINT boardings_boarding_event_accepted_fk
    FOREIGN KEY (boarding_event_id, boarding_event_accepted)
    REFERENCES scan_events (event_id, accepted) ON DELETE RESTRICT,
  CONSTRAINT boardings_exit_event_accepted_fk
    FOREIGN KEY (exit_event_id, exit_event_accepted)
    REFERENCES scan_events (event_id, accepted) MATCH SIMPLE ON DELETE RESTRICT,

  CONSTRAINT boardings_exit_after_boarding CHECK (exited_at IS NULL OR exited_at >= boarded_at),
  CONSTRAINT boardings_closed_fields_together
    CHECK ((exited_at IS NULL) = (closed_reason IS NULL)),
  CONSTRAINT boardings_exit_event_needs_exit
    CHECK (exit_event_id IS NULL OR exited_at IS NOT NULL)
);

-- Idempotency: one boarding row per boarding tap, one exit per exit tap.
CREATE UNIQUE INDEX uq_boardings_boarding_event ON boardings (boarding_event_id);
CREATE UNIQUE INDEX uq_boardings_exit_event ON boardings (exit_event_id)
  WHERE exit_event_id IS NOT NULL;

-- D-002 depends on this: a student is aboard exactly one bus, or none. This is
-- what makes "tap from someone already aboard == exit" well defined.
CREATE UNIQUE INDEX uq_boardings_one_open_per_student ON boardings (student_id)
  WHERE exited_at IS NULL;

-- Hot query: live manifest for a bus.
CREATE INDEX idx_boardings_bus_open ON boardings (bus_id, boarded_at)
  WHERE exited_at IS NULL;
-- Hot query: open (never-scanned-off) records for a route run — reconciliation.
CREATE INDEX idx_boardings_run_open ON boardings (route_run_id, boarded_at)
  WHERE exited_at IS NULL;
-- Hot query: ride history for a student by date range.
CREATE INDEX idx_boardings_student_boarded ON boardings (student_id, boarded_at DESC);
-- Full run detail for reports/exports.
CREATE INDEX idx_boardings_run ON boardings (route_run_id, boarded_at);
-- Wrong-bus reporting.
CREATE INDEX idx_boardings_wrong_bus ON boardings (boarded_at DESC) WHERE wrong_bus;

CREATE TRIGGER trg_boardings_updated_at
  BEFORE UPDATE ON boardings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE boardings IS
  'One ride. exited_at IS NULL means currently aboard, so this is both the live manifest and the ride history. A rejected credential cannot appear here (D-009, composite FK on accepted).';
COMMENT ON COLUMN boardings.boarding_event_accepted IS
  'Structural guard, not data: pinned true so the composite FK can only match an accepted scan_events row (D-009).';

-- Convenience view matching ManifestEntry/BusManifest in the shared contract.
-- clip_ref is LEFT JOINed from scan_enrichment: per D-008 it arrives later, so
-- a manifest entry is complete without it and simply gains it when it lands.
CREATE VIEW current_manifest AS
SELECT
  b.bus_id,
  b.route_run_id,
  b.student_id,
  s.first_name,
  s.last_name,
  s.grade,
  b.boarded_at,
  b.boarding_event_id,
  e.clip_ref,
  e.gps_lat  AS boarding_lat,
  e.gps_lon  AS boarding_lon,
  b.boarding_stop_id,
  b.wrong_bus,
  a.stop_id AS assigned_stop_id
FROM boardings b
JOIN students s ON s.student_id = b.student_id
LEFT JOIN scan_enrichment e ON e.event_id = b.boarding_event_id
LEFT JOIN student_assignments a
  ON a.student_id = b.student_id AND a.effective_to IS NULL
WHERE b.exited_at IS NULL;

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
--
-- Mirrors the Alert interface. triggering_event_id is nullable because
-- reconciliation alerts are raised by the absence of an event.

CREATE TABLE alerts (
  alert_id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind                text        NOT NULL CHECK (kind IN ('wrong_bus', 'never_scanned_off')),
  student_id          text        NOT NULL REFERENCES students   (student_id)   ON DELETE RESTRICT,
  bus_id              text        NOT NULL REFERENCES buses      (bus_id)       ON DELETE RESTRICT,
  route_run_id        text        NOT NULL REFERENCES route_runs (route_run_id) ON DELETE RESTRICT,
  raised_at           timestamptz NOT NULL DEFAULT now(),
  triggering_event_id text        REFERENCES scan_events (event_id) ON DELETE RESTRICT,
  boarding_id         bigint      REFERENCES boardings (boarding_id) ON DELETE SET NULL,
  detail              text        NOT NULL,
  acknowledged_at     timestamptz,
  acknowledged_by     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alerts_ack_fields_together
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);

-- Deliberate dedupe: one alert of each kind per student per run. Reprocessing
-- a run, or a retried webhook delivery, must not spam the portal.
CREATE UNIQUE INDEX uq_alerts_kind_run_student ON alerts (kind, route_run_id, student_id);

CREATE INDEX idx_alerts_open ON alerts (raised_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX idx_alerts_run ON alerts (route_run_id, raised_at DESC);
CREATE INDEX idx_alerts_student ON alerts (student_id, raised_at DESC);
CREATE INDEX idx_alerts_bus ON alerts (bus_id, raised_at DESC);

CREATE TRIGGER trg_alerts_updated_at
  BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
