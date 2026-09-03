# Decisions

Append-only. One entry per decision that constrains later work.

---

**D-001 — Normalized `ScanEvent` is the internal contract.**
The real Verkada webhook payload is not yet pinned down. Rather than block the
build on it, all logic operates on a normalized `ScanEvent`
(`middleware/src/types/events.ts`), and `middleware/src/webhook/normalize.ts`
is the only module that knows Verkada's wire format. Swapping in the real
schema should touch that one file and its tests.

**D-002 — Direction is used when reported, derived otherwise.** *(revised — see
D-006)* Verkada's access event carries a `direction` field ("Inbound" /
"Outbound") but it is populated **only when the door is configured as an In/Out
Door**; it is null otherwise. So: prefer the reported direction; fall back to
deriving it from state (a tap from a student not currently aboard is a
boarding, a tap from a student already aboard is an exit). Derivation is a
heuristic — a double-tap at boarding reads as an instant exit, so derived mode
needs a debounce window. `ResolvedScan.directionSource` records which path was
used. **Recommendation for the pilot: configure the bus door as an In/Out Door.**
It removes the debounce heuristic and an entire class of manifest error.

**D-003 — `occurredAt` orders events, not `receivedAt`.**
Cellular gateways buffer. Events can arrive minutes late and out of order, so
all state transitions order on the on-bus timestamp and the pipeline must
tolerate late arrivals rather than assume wall-clock ordering.

**D-004 — Webhook always returns 2xx for accepted-but-unapplied events.**
Unknown card, duplicate, and stale events are recorded and dropped, not
errored, so Verkada does not retry them indefinitely. Only signature failures
and malformed bodies get 4xx.

**D-005 — Wrong-bus is a flag, not a rejection.**
A student boarding an unassigned bus is still aboard that bus and must appear
on its manifest. The mismatch raises an alert; it never withholds the boarding.

---

*The entries below replace assumptions made before the real Verkada schema was
available. Sources: [Access Events Webhooks](https://apidocs.verkada.com/reference/access-events-webhooks)
and [Securing Webhooks](https://apidocs.verkada.com/reference/securing-webhooks),
both retrieved 2026-09-02.*

**D-006 — Real payload shape supersedes the provisional one.**
Envelope is `{org_id, webhook_type: "notification", created_at, webhook_id,
data}`. `webhook_type` is the literal string `"notification"` for every access
event; the discriminator we actually switch on is `data.notification_type`.
The tap timestamp is `data.created` (epoch **seconds, integer**), not a
`timestamp` field. There is no `credential` object and no `result` field.

**D-007 — `user_info.user_id` is the identity key, not the card number.**
`data.input_value` is not stable across event types: an accepted keycard reports
`"109|35302"` (facility|card), while rejected and NFC events report a 40-bit
binary string. Keying the roster off it would break silently. `user_info.user_id`
is a stable Verkada UUID and is present on accepted events, so the roster maps
Verkada user → student, and `input_value` is retained for audit only. Students
must therefore be enrolled as Verkada access users, which the card-issuing
workflow already implies.

**D-008 — The webhook carries no GPS and no video reference.**
Neither is in the access event payload. `door_info.camera_info` exists but is
null in every documented example. Both are enrichment, fetched from Command
after the fact and attached via `ScanEnrichment` — never awaited in the request
path. This corrects the proposal, which implied they arrive with the event.

**D-009 — Only `*_accepted` credential events board a student.**
`door_keycard_entered_rejected` and friends are recorded (they are useful
signal: a rejected tap at the door is a student who tried) but never change the
manifest. Every other `notification_type` — door held open, tamper, fire alarm,
aux input — returns 200 and is ignored.

**D-010 — Webhook responds in under 2000 ms, always.**
Verkada requires it. Persistence, enrichment, and alert fan-out therefore happen
off the response path. Per Verkada's contract: 200 success, 4xx invalid, 500 =
retry later — so a database outage should 500 (we want the retry) while an
unknown user should 200 (retrying will not help).

**D-011 — Signature scheme is Verkada's, not Stripe's.**
Header `Verkada-Signature: <timestamp>|<signature>`, pipe-separated. The signed
payload is `rawBody + "|" + timestamp` — body first, then timestamp, which is
the reverse of the Stripe convention it superficially resembles. HMAC-SHA256
with the shared secret, hex digest, constant-time compare. Verkada's own sample
uses a 60-second tolerance and returns 403 for both expired and invalid
signatures, 400 for a missing header. Raw bytes must be preserved — any JSON
round-trip before verification breaks the digest.

**D-013 — Only `assignedBusId` is required on a roster entry.**
`StudentAssignment` originally required route, stop, name and grade. Nothing in
the boarding logic reads them — only the wrong-bus comparison is load-bearing —
and the seed's roster export does not carry a stop id, so requiring them made
the composition root silently drop all 59 assigned students and every tap came
back `unknown_user`. They are now optional display metadata. A roster source
that lacks SIS detail must still be able to board children correctly.

**D-012 — PII is dropped at the adapter boundary.**
`user_info` arrives with the student's name, email, and phone on every single
event. `normalize.ts` keeps `user_id` and discards the rest immediately, so no
downstream module, log line, or database row can leak it. The raw payload is
persisted for forensics with `user_info` redacted to `user_id` only.
