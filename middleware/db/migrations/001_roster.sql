-- 001_roster.sql
-- Roster / reference data: the district-controlled facts the boarding logic
-- resolves a card tap against.
--
-- Designed against the real Verkada Access Events webhook payload
-- (docs/decisions.md D-006..D-012). The identity key is `user_info.user_id` — a
-- stable Verkada UUID — NOT the credential number in `data.input_value` (D-007).
--
-- Conventions (docs/CLAUDE.md):
--   * every point-in-time column is `timestamptz`. The only bare `date` is
--     route_runs.service_date in 002, which is a calendar day, not an instant.
--   * primary keys are `text` because the shared contract
--     (middleware/src/types/events.ts) models StudentId / BusId / RouteId /
--     StopId / VerkadaUserId / CardId as branded strings.
--   * synthetic data only — see middleware/seed/.

-- Needed for the non-overlapping validity-period EXCLUDE constraints on
-- student_verkada_links, credentials and student_assignments (equality on a
-- text column combined with a range overlap test). Ships with Postgres contrib.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- buses
-- ---------------------------------------------------------------------------

CREATE TABLE buses (
  bus_id      text        PRIMARY KEY,
  label       text        NOT NULL,
  capacity    integer     NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_buses_updated_at
  BEFORE UPDATE ON buses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE buses IS 'Physical vehicles. bus_id matches the BusId branded string in the shared contract.';

-- ---------------------------------------------------------------------------
-- readers  (the "reader map" the shared contract refers to)
-- ---------------------------------------------------------------------------
--
-- The webhook identifies where a tap happened with `data.device_id` (the access
-- control object) and `data.door_id` (null on ACU-level events) — see the
-- ScanEvent.deviceId / doorId fields. This table maps that pair onto a bus.
--
-- A row with door_id NULL is a device-wide fallback: every door on that ACU
-- belongs to the bus. A row with a door_id is more specific and wins, which is
-- what a multi-door ACU (one controller, two vehicles) needs.
--
-- No match => RejectionReason 'unknown_reader' (D-004: recorded, 2xx, dropped).

CREATE TABLE readers (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   text        NOT NULL,
  door_id     text,
  bus_id      text        NOT NULL REFERENCES buses (bus_id) ON DELETE RESTRICT,
  label       text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- coalesce() rather than a partial index so the device-wide row and the
-- door-specific rows share one uniqueness rule.
CREATE UNIQUE INDEX uq_readers_device_door ON readers (device_id, (coalesce(door_id, '')));
CREATE INDEX idx_readers_bus ON readers (bus_id);

CREATE TRIGGER trg_readers_updated_at
  BEFORE UPDATE ON readers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE readers IS
  '(device_id, door_id) -> bus_id. Resolved by the webhook pipeline; an unmatched device is RejectionReason unknown_reader.';

-- Single definition of the door-specific-wins precedence rule, so the webhook
-- and any reporting query cannot disagree about it.
CREATE OR REPLACE FUNCTION resolve_bus_for_reader(p_device_id text, p_door_id text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT r.bus_id
    FROM readers r
   WHERE r.active
     AND r.device_id = p_device_id
     AND (r.door_id IS NULL OR r.door_id IS NOT DISTINCT FROM p_door_id)
   ORDER BY (r.door_id IS NULL)  -- false (door-specific) sorts before true
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- routes
-- ---------------------------------------------------------------------------

CREATE TABLE routes (
  route_id      text        PRIMARY KEY,
  name          text        NOT NULL,
  -- The bus normally scheduled to run this route. Actual vehicle for a given
  -- run lives on route_runs.bus_id (buses get swapped).
  bus_id        text        REFERENCES buses (bus_id) ON DELETE SET NULL,
  school_year   text        NOT NULL,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_routes_bus ON routes (bus_id);

CREATE TRIGGER trg_routes_updated_at
  BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- stops
-- ---------------------------------------------------------------------------

CREATE TABLE stops (
  stop_id     text             PRIMARY KEY,
  name        text             NOT NULL,
  lat         double precision CHECK (lat BETWEEN -90 AND 90),
  lon         double precision CHECK (lon BETWEEN -180 AND 180),
  created_at  timestamptz      NOT NULL DEFAULT now(),
  updated_at  timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT stops_latlon_together CHECK ((lat IS NULL) = (lon IS NULL))
);

CREATE TRIGGER trg_stops_updated_at
  BEFORE UPDATE ON stops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- route_stops  (ordered stops on a route)
-- ---------------------------------------------------------------------------

CREATE TABLE route_stops (
  route_id            text        NOT NULL REFERENCES routes (route_id) ON DELETE CASCADE,
  stop_id             text        NOT NULL REFERENCES stops (stop_id)  ON DELETE RESTRICT,
  stop_sequence       integer     NOT NULL CHECK (stop_sequence > 0),
  -- Minutes after the run's scheduled start that this stop is served. Used to
  -- guess a boarding stop from a tap time; not a hard schedule.
  scheduled_offset_min integer    NOT NULL DEFAULT 0 CHECK (scheduled_offset_min >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, stop_id)
);

-- Ordering within a route is unique so "stop 4 of route A" is unambiguous.
CREATE UNIQUE INDEX uq_route_stops_sequence ON route_stops (route_id, stop_sequence);
CREATE INDEX idx_route_stops_stop ON route_stops (stop_id);

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
--
-- Names here come from the district SIS roster load, which is the district's
-- own data. They are NOT sourced from a webhook: D-012 forbids persisting
-- anything out of Verkada's `user_info` beyond `user_id`, and nothing in the
-- ingest path may write to this table.

CREATE TABLE students (
  student_id  text        PRIMARY KEY,
  first_name  text        NOT NULL,
  last_name   text        NOT NULL,
  grade       text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_students_last_first ON students (lower(last_name), lower(first_name));

CREATE TRIGGER trg_students_updated_at
  BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE students IS
  'SYNTHETIC ONLY in every non-production environment. Never load a real roster here (docs/CLAUDE.md hard rules). Populated from the district SIS, never from a webhook payload (D-012).';

-- ---------------------------------------------------------------------------
-- verkada_users  (the access users the webhook actually identifies)
-- ---------------------------------------------------------------------------
--
-- D-007: `data.user_info.user_id` is a stable Verkada UUID and is the identity
-- key for the whole pipeline. Students are enrolled as Verkada access users,
-- which the card-issuing workflow already implies.
--
-- This table deliberately has no name / email / phone column. Verkada sends all
-- three inside `user_info` on every event; D-012 says they are dropped at the
-- adapter boundary and never persisted. There is nowhere here to put them.

CREATE TABLE verkada_users (
  verkada_user_id   text        PRIMARY KEY,
  -- Optional district-side handle (SIS export id, badge request ticket, ...).
  -- Free text; must not be an email address or any other direct identifier.
  external_ref      text,
  active            boolean     NOT NULL DEFAULT true,
  provisioned_at    timestamptz NOT NULL DEFAULT now(),
  deprovisioned_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verkada_users_period_ordered
    CHECK (deprovisioned_at IS NULL OR deprovisioned_at > provisioned_at),
  CONSTRAINT verkada_users_inactive_when_deprovisioned
    CHECK (deprovisioned_at IS NULL OR NOT active)
);

CREATE TRIGGER trg_verkada_users_updated_at
  BEFORE UPDATE ON verkada_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE verkada_users IS
  'Verkada access users, keyed by user_info.user_id (D-007). NO PII COLUMNS BY DESIGN — name/email/phone from user_info are discarded at the adapter (D-012).';

-- ---------------------------------------------------------------------------
-- student_verkada_links  (verkada user <-> student, point-in-time)
-- ---------------------------------------------------------------------------
--
-- This is the join the webhook does on every accepted tap, and it is
-- period-scoped for the same reason the old card table was: cellular gateways
-- buffer, so a late-arriving event (D-003) must resolve against the link that
-- was in force at `occurred_at`, not the link in force now.
--
--   SELECT student_id FROM student_verkada_links
--    WHERE verkada_user_id = $1
--      AND linked_at <= $2
--      AND (unlinked_at IS NULL OR unlinked_at > $2);
--
-- What actually changes over time here is enrollment, not credentials: a
-- student re-provisioned under a new Verkada access user (transfer, deleted and
-- recreated account) gets the old link closed and a new one opened. Losing and
-- replacing a physical card no longer touches identity at all — that is the
-- whole point of D-007 — and is recorded in `credentials` for audit only.

CREATE TABLE student_verkada_links (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verkada_user_id  text        NOT NULL REFERENCES verkada_users (verkada_user_id) ON DELETE RESTRICT,
  student_id       text        NOT NULL REFERENCES students (student_id) ON DELETE CASCADE,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  unlinked_at      timestamptz,
  -- Free-text reason: 'transferred', 'reprovisioned', 'withdrawn', ...
  unlinked_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_verkada_links_period_ordered
    CHECK (unlinked_at IS NULL OR unlinked_at > linked_at),
  CONSTRAINT student_verkada_links_reason_only_when_unlinked
    CHECK (unlinked_reason IS NULL OR unlinked_at IS NOT NULL)
);

-- One live student per Verkada user, and one live Verkada user per student.
CREATE UNIQUE INDEX uq_student_verkada_links_active_user ON student_verkada_links (verkada_user_id)
  WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX uq_student_verkada_links_active_student ON student_verkada_links (student_id)
  WHERE unlinked_at IS NULL;

-- A Verkada user id can never resolve to two students at the same instant —
-- this is what makes point-in-time resolution single-valued.
ALTER TABLE student_verkada_links ADD CONSTRAINT student_verkada_links_no_overlapping_user
  EXCLUDE USING gist (
    verkada_user_id WITH =,
    tstzrange(linked_at, unlinked_at, '[)') WITH &&
  );

-- ...and a student is never behind two Verkada users at the same instant.
ALTER TABLE student_verkada_links ADD CONSTRAINT student_verkada_links_no_overlapping_student
  EXCLUDE USING gist (
    student_id WITH =,
    tstzrange(linked_at, unlinked_at, '[)') WITH &&
  );

-- Point-in-time resolution of a tap (hot path on every accepted webhook event).
CREATE INDEX idx_student_verkada_links_user_linked
  ON student_verkada_links (verkada_user_id, linked_at DESC);
CREATE INDEX idx_student_verkada_links_student
  ON student_verkada_links (student_id, linked_at DESC);

CREATE TRIGGER trg_student_verkada_links_updated_at
  BEFORE UPDATE ON student_verkada_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE student_verkada_links IS
  'Identity resolution: Verkada user_id -> student, as of occurred_at (D-003/D-007). The single join the boarding pipeline is allowed to make on inbound events.';

-- Same lookup as above, as a function, so "resolve as of the tap time, not now"
-- has one canonical implementation.
CREATE OR REPLACE FUNCTION resolve_student_at(p_verkada_user_id text, p_at timestamptz)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT l.student_id
    FROM student_verkada_links l
   WHERE l.verkada_user_id = p_verkada_user_id
     AND l.linked_at <= p_at
     AND (l.unlinked_at IS NULL OR l.unlinked_at > p_at)
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- credentials  (audit / provenance for physical cards — NOT a join key)
-- ---------------------------------------------------------------------------
--
-- D-007: `data.input_value` is not stable across event types. An accepted
-- keycard reports "109|35302" (facility|card); rejected and NFC events report a
-- 40-bit binary string; a face event reports a UUID. Keying anything off it
-- would break silently, so nothing in the ingest path joins to this table and
-- scan_events.input_value carries no foreign key to it.
--
-- What this table is for: answering "which physical badge produced that
-- input_value, and who was holding it" during an incident review, and keeping
-- the reissue / recycle history the district's badge office actually generates.
-- It is period-scoped so a card number that changes hands still has exactly one
-- holder at any instant.

CREATE TABLE credentials (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verkada_user_id    text        NOT NULL REFERENCES verkada_users (verkada_user_id) ON DELETE CASCADE,
  -- Wiegand facility code, when the format has one. Null for NFC/face.
  facility_code      integer     CHECK (facility_code IS NULL OR facility_code >= 0),
  -- The card number as printed / enrolled. Text, not integer: leading zeros and
  -- non-numeric formats both occur.
  card_number        text        NOT NULL CHECK (card_number <> ''),
  credential_type    text        NOT NULL DEFAULT 'keycard'
                                 CHECK (credential_type IN ('keycard', 'nfc', 'face', 'other')),
  issued_at          timestamptz NOT NULL DEFAULT now(),
  deactivated_at     timestamptz,
  -- Free-text reason for deactivation: 'lost', 'damaged', 'transferred', ...
  deactivated_reason text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_validity_ordered
    CHECK (deactivated_at IS NULL OR deactivated_at > issued_at),
  CONSTRAINT credentials_reason_only_when_deactivated
    CHECK (deactivated_reason IS NULL OR deactivated_at IS NOT NULL)
);

-- One live holder per physical card at a time.
CREATE UNIQUE INDEX uq_credentials_active_card
  ON credentials ((coalesce(facility_code, -1)), card_number)
  WHERE deactivated_at IS NULL;

-- The same card number can never be held by two users over overlapping time.
ALTER TABLE credentials ADD CONSTRAINT credentials_no_overlapping_holders
  EXCLUDE USING gist (
    card_number WITH =,
    (coalesce(facility_code, -1)) WITH =,
    tstzrange(issued_at, deactivated_at, '[)') WITH &&
  );

-- Audit lookup: "which badge was this input_value".
CREATE INDEX idx_credentials_number ON credentials (card_number, issued_at DESC);
CREATE INDEX idx_credentials_user ON credentials (verkada_user_id);

CREATE TRIGGER trg_credentials_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE credentials IS
  'Badge provenance only. Never joined on during ingest — input_value is not a stable key (D-007).';

-- The "109|35302" form an accepted keycard event puts in `input_value`, for
-- eyeballing an audit trail. A view, not a stored column, precisely because
-- input_value formatting is Verkada's business and varies by event type.
CREATE VIEW credential_input_values AS
SELECT
  c.id,
  c.verkada_user_id,
  c.credential_type,
  CASE
    WHEN c.facility_code IS NULL THEN c.card_number
    ELSE c.facility_code::text || '|' || c.card_number
  END AS accepted_keycard_input_value,
  c.issued_at,
  c.deactivated_at
FROM credentials c;

-- ---------------------------------------------------------------------------
-- student_assignments  (student -> bus / route / stop)
-- ---------------------------------------------------------------------------
--
-- Also period-scoped, so a mid-year route change does not rewrite history.
-- A student with no row here is unassigned: they still board and still appear
-- on the manifest (D-005 logic generalizes — never withhold a boarding), the
-- wrong-bus check simply has nothing to compare against.

CREATE TABLE student_assignments (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id      text        NOT NULL REFERENCES students (student_id) ON DELETE CASCADE,
  bus_id          text        NOT NULL REFERENCES buses  (bus_id)  ON DELETE RESTRICT,
  route_id        text        NOT NULL REFERENCES routes (route_id) ON DELETE RESTRICT,
  stop_id         text        NOT NULL REFERENCES stops  (stop_id)  ON DELETE RESTRICT,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_assignments_period_ordered
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- The assigned stop must actually be on the assigned route.
  CONSTRAINT student_assignments_stop_on_route
    FOREIGN KEY (route_id, stop_id) REFERENCES route_stops (route_id, stop_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_student_assignments_active ON student_assignments (student_id)
  WHERE effective_to IS NULL;

ALTER TABLE student_assignments ADD CONSTRAINT student_assignments_no_overlap
  EXCLUDE USING gist (
    student_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  );

-- Roster lookups: "who is assigned to this bus / route".
CREATE INDEX idx_student_assignments_bus ON student_assignments (bus_id) WHERE effective_to IS NULL;
CREATE INDEX idx_student_assignments_route ON student_assignments (route_id) WHERE effective_to IS NULL;
CREATE INDEX idx_student_assignments_student_from ON student_assignments (student_id, effective_from DESC);

CREATE TRIGGER trg_student_assignments_updated_at
  BEFORE UPDATE ON student_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- roster view: the StudentAssignment shape from the shared contract, as of now
-- ---------------------------------------------------------------------------

CREATE VIEW current_student_assignments AS
SELECT
  s.student_id,
  l.verkada_user_id,
  s.first_name,
  s.last_name,
  s.grade,
  a.bus_id   AS assigned_bus_id,
  a.route_id AS assigned_route_id,
  a.stop_id  AS assigned_stop_id
FROM students s
LEFT JOIN student_verkada_links l
  ON l.student_id = s.student_id AND l.unlinked_at IS NULL
LEFT JOIN student_assignments a
  ON a.student_id = s.student_id AND a.effective_to IS NULL
WHERE s.active;

COMMENT ON VIEW current_student_assignments IS
  'Mirrors the StudentAssignment interface in middleware/src/types/events.ts (verkadaUserId, not cardId — D-007). Columns are nullable here because a student may have no Verkada user or no assignment; the contract type is only satisfiable for rows where both are present.';
