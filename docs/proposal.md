# Bus Ridership Accountability System — Spec

Functional reference for the build. Scope, stack, and conventions: `CLAUDE.md`.

## How it works

Each bus carries a Verkada card reader wired to an access controller at the
door, a door-facing camera, and a GC31-E cellular gateway supplying
connectivity, GPS, and PoE, wired to the ignition through a timed relay.
Students tap on when boarding and off when exiting.

```
tap → Verkada reader + door camera → GC31-E (cellular + GPS)
    → Verkada Command cloud (event + footage)
    → [webhook, real time] → middleware ←→ roster DB
        ├─→ portal (manifest, alerts, history)
        └─→ parent SMS (Phase 2)
```

A tap produces a Verkada access event carrying card identity, reader, and
timestamp. Command pushes it to the middleware, which validates it, resolves
card → student, applies boarding/exit logic, attaches the video clip reference
and GPS position, and updates portal state.

## Capabilities

**Live manifest.** Per-bus, real time: who is aboard, with name, grade,
boarding time, assigned stop, and the boarding video frame. Reflects actual
riders, not the planned roster.

**Wrong-bus flag.** Raised at scan time when a student boards a bus other than
their assigned one.

**End-of-route reconciliation.** Any student scanned on but never scanned off
triggers an alarm before the driver leaves the vehicle.

**Ride history.** Searchable per student — every pickup and drop-off with
time, location, and video clip. Backs "where is my child" calls, custody
verification, Medicaid-reimbursable SPED trip logs, and state ridership
counts, all as report exports.

**Parent SMS (Phase 2).** Board/exit text with bus, time, and a secure detail
link. Sequenced after staff use proves the pipeline; ~5,000 families.

## Implications for the build

- Roster maps card ID → student, grade, assigned bus/route, assigned stop.
- Boarding state is per-bus, per-route-run; reconciliation needs a defined
  end-of-route trigger.
- Every event needs a video clip reference and GPS position resolvable from
  Command.
- Student data stays in district-controlled systems. Phase 2 SMS is the only
  outbound path, carrying minimum necessary detail. Video stays in Command and
  district storage under district retention policy.

## Rollout

Single-bus pilot (1–2 months) → fleet expansion → parent notifications.

## Open items

- Confirm vehicle-mount support for access control hardware with the Verkada rep.
- Select pilot route.
- Legal review of the data-handling plan before Phase 2.
