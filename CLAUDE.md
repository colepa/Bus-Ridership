# Bus ridership MVP

Students tap an RFID card at the bus door. Verkada Command pushes the access
event here by webhook. We show who is currently on the bus.

**Real hardware, fake people.** Real Verkada org, real AC12 and readers. The
roster is test users I made in Command — no actual student data, ever.

**Goal:** prove the pipeline works end to end and demo it. Not production.

## How to write code for me

I know Python and C++. I don't read TypeScript, Go, or Rust — if you write
them, I can't maintain this. **Everything in Python.**

I have to be able to read every line and change it myself. Plain functions and
dicts. No class hierarchies, no dependency injection, no patterns unless I ask.
Obvious beats clever. As few files as the problem allows.

## MVP scope

1. Webhook endpoint — verify signature, parse the access event
2. `user_id` → test student lookup
3. Who's on the bus: tap-on, tap-off, end-of-route "never tapped off" check
4. One page showing the live manifest

**Not in the MVP:** GPS (no API exists for it) · video clips · database or
migrations (a dict plus a JSON file is fine) · auth · parent notifications ·
Docker or CI · exhaustive tests · abstractions for things with one
implementation.

## Stack

Python 3.12 · FastAPI · uvicorn · `uv`. State in memory, saved to a JSON file
so a restart doesn't kill the demo. Plain HTML + `fetch` — no React, no build
step.

## How to work with me

- Ask before building anything non-trivial. A question beats the wrong 400 lines.
- Smallest working version first. Fake tap on the page, then we decide what's next.
- If I say input is coming, wait for it.
- One agent unless I say otherwise.
- Tell me when I'm asking for something overbuilt for an MVP.

## Hard rules

Never commit secrets — API key and webhook signing secret live in `.env`,
gitignored. Test users only; `tools/verkada-probe/captures/` holds real names
and card numbers from the test org and stays out of git.

## Reference — read when relevant, not every time

- `verkada-notes.md` — payload shape, signature scheme, the two gotchas.
  Read before touching the webhook.


## Status (2026-10-13)

MVP scope 1–4 built and working against the real AC12. Pushed to
github.com/colepa/Bus-Ridership.

**Files**
- `app.py` — webhook, per-bus state, manifest logic, page/API endpoints
- `verkada_api.py` — Command API calls for "Refresh roster" (doors, access
  levels, groups, users)
- `index.html` — overview of all buses; click one for its manifest
- `fake_tap.py` — signed fake taps (`--door`, `--type`, `unknown` user)
- `simulate.py` — plays out a route (`board` / `dropoff`) with fake taps
- `fake_buses.json` — buses 2–4, made up, not in Command; loaded at startup
- `seed_users.py` — adds 49 `busdemo-` test users to Bus 1's group in
  Command (`--delete` removes them)
- `tools/verkada-probe/` — the original capture scripts (webhook + `GET /v2/events`)

**Decisions made (details in `verkada-notes.md`)**
- Each door in Command = one bus. Every door in the org is listed.
- One reader per bus, taps toggle on/off. No In/Out doors (student
  compliance risk). Taps stored by `event_id`; on/off recomputed from sorted
  taps each time; 3 s debounce for testing (30 s planned for real use).
- Only `door_keycard_entered_accepted` boards. `door_unlocked`/`door_locked`
  ignored. `door_keycard_entered_rejected` → alert (unknown card, or known
  student not assigned to this bus), never counted as boarding.
- Roster = users with access to the door in Command (access levels →
  groups → users). Schedules ignored. Fetched only on "Refresh roster".
- Routes started/ended by hand per bus. Starting a route moves the previous
  one (with a roster snapshot) into `state["past_routes"]`, then clears it.
- Student lookup (proposal priority 2): search bar + Students page; student
  page shows where they are now and every past route (rode, no show, wrong
  bus, rejected, never tapped off). No stop or video column yet — no GPS,
  video is the next feature. `simulate.py history` makes 10 days of fake past
  routes (marked `"demo": true`, replaced on re-run).
- UI styled after the proposal mock (Command-like: sidebar, tiles, pills).
- Backfill dropped from scope — testing is stationary with good connectivity.

**How to run**
1. `uv run uvicorn app:app --port 8000`
2. `ngrok http 8000 --url https://hatchery-tactical-moneyless.ngrok-free.dev`
   (permanent free domain; webhook in Command points at `<that>/webhook`)
3. Open the dashboard at `http://localhost:8000`, **not** the ngrok URL —
   the 2 s polling would burn ngrok's 20k requests/month free cap.

**Not yet verified on real hardware**
- "Refresh roster" against the live API. The docs don't name the door-id
  field in Get Doors; if the terminal prints `door with no id field`, fix the
  key lookup in `verkada_api.fetch_buses`.

**Open ideas, not started**
- Rejected-but-boarded students make the headcount one short (shown as alert).
- Sync-from-Verkada button using `GET /v2/events` if backfill comes back.
