# Bus Ridership Accountability System

RFID tap-on/tap-off ridership tracking for a school district, built on the
district's existing Verkada camera/access-control platform. Functional spec:
`docs/proposal.md`.

## Scope

We build the district software layer only. Verkada hardware and Verkada
Command already exist and are not ours to configure. In development Verkada is
simulated by `tools/mock-verkada/`, which POSTs realistic access-event
payloads to the middleware webhook.

## Stack (pinned — don't substitute without updating this file)

Node.js + TypeScript + Express · PostgreSQL · React + TypeScript (Vite) ·
Vitest + supertest. Keep dependencies minimal; this is a single-bus pilot, not
a platform.

## Layout

```
docs/                  spec, decisions log
middleware/            webhook receiver, boarding logic, portal API
portal/                React frontend
tools/mock-verkada/    fake Verkada event generator
```

## Build order (one GitHub issue each, in sequence)

1. Mock event generator
2. Middleware core — webhook receiver, roster matching, boarding/exit state
   machine, end-of-route reconciliation
3. Portal live manifest
4. Alerts — wrong bus, never-scanned-off
5. Ride history + search
6. Video clip / GPS retrieval against real Command
7. Parent SMS (Phase 2) — blocked on legal review

## Conventions

- Branch `issue-<n>-short-description`; open a PR, never push to main.
- Short imperative commit summary lines.
- TypeScript strict mode; no `any` without a comment explaining why.
- Log stack, schema, and webhook-payload decisions in `docs/decisions.md`.

## Hard rules

- **Synthetic data only.** Never commit real rosters, names, or card IDs —
  seed from `middleware/seed/`.
- **Never commit secrets** (Verkada API keys, webhook signing secret, database
  URL, SMS credentials). They live in a gitignored `.env`. A committed secret
  is a compromised secret — rotate it.
- Verify the webhook signature on every incoming event; reject unsigned or
  stale ones.
- No full student records in logs or outbound messages.

## Status

Pilot planning. No code yet. Next: issue #1. Update this line as milestones land.
