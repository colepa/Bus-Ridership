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


## Status

Starting over in Python. Nothing written yet.
