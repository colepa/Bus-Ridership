# mock-verkada

Fake Verkada event source. Simulates a full route run — students boarding at
stops over time, then exiting at school — and POSTs correctly signed access
events at the middleware webhook. It also produces, on demand, the failure
cases the ridership system exists to catch.

Zero runtime dependencies: Node 22 built-ins only (`fetch`, `node:crypto`,
`node:util`).

## The payload is the real one

`src/payload.ts` mirrors the **real** Verkada access-event schema, from
[Access Events Webhooks](https://apidocs.verkada.com/reference/access-events-webhooks)
and [Securing Webhooks](https://apidocs.verkada.com/reference/securing-webhooks)
(retrieved 2026-09-02). It replaces the invented shape this tool used before the
schema was available; see `docs/decisions.md` D-006 through D-012.

Two files know the wire format, one on each side:

- `middleware/src/webhook/normalize.ts` (+ `verifySignature.ts`) — the receiver
- `tools/mock-verkada/src/payload.ts` — this sender

Nothing else in either package mentions a Verkada field name (D-001).

```jsonc
{
  "org_id": "org_demo_district",
  "webhook_type": "notification",     // literal, for every access event
  "created_at": 1744674140,           // epoch seconds, Command emit time
  "webhook_id": "wh_...",
  "data": {
    "event_id": "evt_...",
    "device_id": "RDR-101-DOOR",
    "created": 1744674135,            // epoch SECONDS — the tap time
    "notification_type": "door_keycard_entered_accepted",   // the discriminator
    "device_type": "access_control",
    "door_id": "RDR-101-DOOR",
    "direction": null,                // "Inbound"/"Outbound" only for In/Out Doors
    "input_value": "109|35001",       // format varies by event type
    "aux_info": null,
    "user_info": { "user_id": "…", "name": "…", "email": "…", "phone": "…" },
    "lockdown_info": null,
    "door_info": { "acu_name": "…", "site": { … }, "camera_info": null }
  }
}
```

Signature transport:

```
Verkada-Signature: <epoch seconds>|<hex hmac-sha256>
signed material:   rawRequestBody + "|" + <epoch seconds>     <- BODY FIRST
tolerance:         60 seconds
```

The ordering is the reverse of the Stripe convention it resembles. Getting it
backwards produces a digest that is wrong every time, with no other symptom.

### It sends PII on purpose

Real `user_info` carries the person's name, email and phone on every event, and
the middleware is required to drop all of it at the adapter boundary (D-012).
So this generator emits it too — invented names, `@example.invalid` addresses,
`+1555…` numbers. It is never printed to the console, and if any of it turns up
in a middleware log line or database row, that is the bug this tool exists to
find.

## Running it

```bash
export VERKADA_WEBHOOK_SECRET=...        # the same secret the middleware loads
npm start --workspace @bus-ridership/mock-verkada -- --scenario happy
```

Build the timeline without sending anything (no secret required):

```bash
npm start --workspace @bus-ridership/mock-verkada -- --scenario all --dry-run
```

`--help` prints the full flag list; `--list` prints the scenarios.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--scenario <list>` | `happy` | Comma-separated scenario names, or `all` |
| `--seed <string>` | `bus-pilot` | PRNG seed. Same seed, same run, byte for byte |
| `--url <url>` | `http://localhost:3000/webhooks/verkada` | Webhook endpoint |
| `--students <n>` | `12` | Riders on the run |
| `--stops <n>` | `4` | Stops on the route |
| `--bus <id>` | `BUS-101` | Bus under test |
| `--other-bus <id>` | `BUS-102` | The bus a wrong-bus boarding happens on |
| `--org <id>` | `org_demo_district` | Verkada org id in the payload |
| `--facility-code <n>` | `109` | Facility code in `input_value` (`facility\|card`) |
| `--roster <path>` | — | JSON array of `{ verkadaUserId, cardId?, studentId?, assignedBusId? }` |
| `--compress <n>` | `60` | Simulated minutes per real second |
| `--instant` | off | Play the whole timeline immediately |
| `--directions` | off | In/Out Door mode: populate `data.direction` |
| `--dry-run` | off | Build and print the timeline, send nothing |
| `--assert` | off | Exit non-zero if any response missed its expectation |
| `--timeout <ms>` | `5000` | Per-request timeout |

### User ids must match the roster (D-007)

Identity keys off `user_info.user_id`, **not** the card number: `input_value` is
`"109|35302"` on an accepted keycard but a 40-bit binary string on a rejected or
NFC read, so a roster keyed on it would break silently.

By default rider N gets the deterministic, obviously-synthetic id

```
00000000-0000-4000-8000-<N zero-padded to 12>      # rider 7 -> …-000000000007
```

Unless the seeded roster in `middleware/seed/` uses those exact ids, every tap
comes back `unknown_user`. Point `--roster` at a JSON export of the seeded
roster to line them up:

```json
[
  {
    "verkadaUserId": "00000000-0000-4000-8000-000000000007",
    "cardId": "109|35007",
    "studentId": "STU-0007",
    "assignedBusId": "BUS-101"
  }
]
```

### Device and door ids

Real Verkada device and door ids are UUIDs; these are readable so they can be
pasted into the middleware's device → bus map, which is configuration on both
sides. They follow the seed's convention: `BUS-101` → `RDR-101-DOOR`, used as
both `device_id` and `door_id`. The run header prints the mapping. If the
middleware's map does not contain them, every event comes back
`unknown_reader`.

### In/Out Doors

Without `--directions`, `data.direction` is `null` — which is what Verkada sends
unless the door is configured as an In/Out Door — and the middleware has to
derive direction from state. With `--directions`, boardings carry `"Inbound"`
and exits `"Outbound"`, exercising the reported-direction path in D-002. Run
both: the pilot recommendation is to configure the real bus door as an In/Out
Door, and this flag is how you show what that buys.

## Scenarios

| Name | What it produces | Expected response |
| --- | --- | --- |
| `happy` | Clean run: everyone boards at their stop, everyone exits at school | all `applied` |
| `wrong-bus` | One student boards `--other-bus` instead of their assigned bus | `applied` + `wrong_bus` alert (D-005) |
| `never-scans-off` | One student boards and never taps off | boarding `applied`; reconciliation must raise `never_scanned_off` |
| `unknown-card` | A Verkada user who is on no roster taps at the door | 200, `unknown_user` |
| `unknown-reader` | A tap from a door with no bus mapping | 200, `unknown_reader` |
| `rejected-credential` | A card and a phone NFC read REFUSED at the door (`*_rejected`, binary `input_value`, null `user_info`) | 200, `credential_rejected`, manifest unchanged (D-009) |
| `ignored-type` | Non-credential door noise: `door_opened`, `door_held_open` | 200, `unsupported_notification_type`, boarding never called |
| `duplicate` | Command re-delivers an event: same `event_id`, new `webhook_id` | 200, `applied: false`, `duplicate_event` |
| `late-burst` | Cellular dropout: five simulated minutes of taps buffered, then flushed at once and out of order | all `applied` (D-003) |
| `bad-signature` | An event signed with the wrong secret | 403, never applied |
| `replay` | A captured event re-sent with its original, now-stale signature timestamp | 403 |
| `malformed` | A signed body missing required fields, and a signed body that is not JSON | 400 |
| `all` | Every failure scenario above in a single run | mixed |

Scenarios compose: `--scenario wrong-bus,never-scans-off,late-burst`.

## Three clocks

The generator keeps the tap time, the delivery time and the signature time
apart on purpose (`docs/decisions.md` D-003, D-011):

- **`data.created`** — when the tap happened at the door. Uncompressed, in real
  seconds, anchored so the simulated route *ends* around now. A 45-minute route
  therefore produces 45 minutes of plausible, in-the-past tap timestamps no
  matter how fast the run plays out, and a five-minute dropout is a real
  five-minute gap. This is what orders state.
- **`created_at` / actual POST time** — when Command got it out over cellular,
  compressed by `--compress` so the run finishes in seconds. `late-burst`
  pushes it minutes later and shuffles arrival order.
- **the signature timestamp** — real wall time at send. Verkada's tolerance is
  60 seconds, so this one is never simulated; `replay` is the scenario that
  deliberately breaks it.

## Output

Each line is `<match> <t> <status> <observed> <label>`, where `+` means the
response matched what the scenario expected and `!` means it did not. The run
ends with a tally; `--assert` turns any mismatch into exit code 1, which makes
this usable as an integration check in CI.

Labels carry opaque student ids only. Credentials, names, emails, phone numbers
and the signing secret are never printed.

## Synthetic data only

Everything here is generated: ids, coordinates, timings, names, contact
details. Never point this tool at a real roster export or commit one into the
repo (`CLAUDE.md`, hard rules).
