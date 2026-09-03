# Seed

1. `cp middleware/.env.example middleware/.env` and set `DATABASE_URL` to a local Postgres you can drop (the seed truncates).
2. From `middleware/`: `npm run migrate` — applies `db/migrations/*.sql` forward-only, tracked in `schema_migrations`. Safe to re-run; `npm run migrate -- --status` lists what is applied.
3. From `middleware/`: `npm run seed` — truncates and rebuilds the roster with ~60 synthetic students, one synthetic Verkada access user each, 3 buses/routes, 8 stops each, plus one open AM `route_run` per route.
4. Data is deterministic (fixed PRNG seed plus pure builders in `fixtures.ts`), so ids are stable across runs; `SEED_SERVICE_DATE=YYYY-MM-DD npm run seed` overrides the run date.
5. Synthetic only — never point this at a real roster.

## Identity (D-007)

The roster is keyed on `verkada_user_id` (Verkada's `user_info.user_id`), not on a
badge number. `data.input_value` is not stable across event types, so badge
numbers live in `credentials` as provenance and nothing joins to them during
ingest.

Synthetic user ids are UUID-shaped but start with the literal `5eed`, e.g.
`5eed0000-0000-4000-8000-01000000001f`. Synthetic badges all sit behind facility
code `999`, so `999|` finds every fake credential.

`student_verkada_links` is period-scoped: resolve with
`resolve_student_at(verkada_user_id, occurred_at)`, never "the link in force
now" — a late-arriving event (D-003) must resolve against the link that was in
force when the tap happened.

## Roster file for the mock generator

`SEED_ROSTER_OUT=./roster.json npm run seed` also writes the roster file that
`tools/mock-verkada --roster` consumes: `{ studentId, verkadaUserId,
acceptedInputValue, assignedBusId?, assignedRouteId?, note? }` per entry, plus
one deliberately-unenrolled entry for the `unknown_user` path. `buildRosterExport()`
in `fixtures.ts` is pure, so tests can import it without a database.

## Edge cases

Listed in `fixtures.ts` under `EDGE_CASES` and echoed to stdout after seeding.

| case | student | exercises |
| --- | --- | --- |
| wrong bus | `STU-0007` | assigned `BUS-101`, boards `BUS-102`; still on the manifest, plus an alert (D-005) |
| reissued badge | `STU-0022` | new badge number at `REISSUE_AT`, **same** access user — resolution must be unaffected (D-007) |
| recycled badge | `STU-0043` -> `STU-0044` | one badge number, two holders, disjoint periods; "latest holder wins" would misattribute taps |
| re-provisioned user | `STU-0031` | new Verkada access user at `REPROVISION_AT`; earlier taps carry the old id and must still resolve (D-003) |
| no assignment | `STU-0060` | boards fine; nothing to compare against, so no wrong-bus determination |
| unknown user | `5eed0000-0000-4000-8000-ffffffffffff` | never enrolled; expect `unknown_user` and a 2xx (D-004) |
