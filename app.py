"""Bus ridership MVP: Verkada webhook in, live manifest per bus out.

Each door in Command is a bus (one AC12 + reader per bus). One reader per bus;
every accepted tap toggles a student on/off. We store the taps themselves and
work out who's on the bus from them each time (see verkada-notes.md, "Direction").

Run:
    uv run uvicorn app:app --port 8000
"""

import asyncio
import hashlib
import hmac
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

import verkada_api  # after load_dotenv, so it sees VERKADA_REGION

SECRET = os.environ["VERKADA_WEBHOOK_SECRET"]
STATE_FILE = HERE / "state.json"

DEBOUNCE_SECONDS = 30       # a second tap by the same student within this is ignored
MAX_SIGNATURE_AGE = 60      # seconds; matches Verkada's own sample
BOARDING_EVENTS = {"door_keycard_entered_accepted"}
REJECTED_EVENTS = {"door_keycard_entered_rejected"}


# ---------------------------------------------------------------- state ----
#
# state = {
#     "buses": {
#         "<door_id>": {
#             "name": "Bus 12",
#             "route": {"started_at": 1791847000, "ended_at": None},   # or None
#             "taps": {
#                 "<event_id>": {"user_id": "...", "name": "...", "time": 1791847605},
#             },
#             # Rejected taps. Shown as alerts, never counted toward on/off — the
#             # driver opens the bus door, so a rejected student probably boarded.
#             "alerts": {
#                 "<event_id>": {"user_id": "..." or None, "name": "..." or None,
#                                "card": "102|53031", "time": 1791847605},
#             },
#             # Who has access to this door in Command. Filled by "Refresh roster".
#             "roster": {"<user_id>": "Student Name"},
#         },
#     },
# }
#
# All endpoints below are `async def`, so FastAPI runs them one at a time on a
# single thread — no locking needed around this dict.

def load_state():
    if STATE_FILE.exists():
        loaded = json.loads(STATE_FILE.read_text())
        if "buses" in loaded:
            return loaded
        # state.json from the single-bus version: start fresh (it's a demo).
    return {"buses": {}}


def save_state():
    # Write to a temp file then rename, so a crash mid-write can't leave half a file.
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)


state = load_state()


def new_bus(name):
    return {"name": name, "route": None, "taps": {}, "alerts": {}, "roster": {}}


def route_active(bus):
    return bus["route"] is not None and bus["route"]["ended_at"] is None


# ------------------------------------------------------------ manifest ----

def compute_manifest(bus):
    """Return (on_bus, off_bus, not_boarded) lists of students for one bus.

    For each student: sort their taps by time, drop any within DEBOUNCE_SECONDS
    of the previous counted tap, then count. Odd = on the bus, even = off.
    not_boarded = on the roster, no accepted tap this route.
    """
    taps_by_student = {}
    for tap in sorted(bus["taps"].values(), key=lambda t: t["time"]):
        taps_by_student.setdefault(tap["user_id"], []).append(tap)

    on_bus, off_bus = [], []
    for user_id, student_taps in taps_by_student.items():
        counted = []
        for tap in student_taps:
            if counted and tap["time"] - counted[-1]["time"] < DEBOUNCE_SECONDS:
                continue
            counted.append(tap)

        student = {
            "user_id": user_id,
            "name": bus["roster"].get(user_id) or counted[-1]["name"],
            "taps": len(counted),
            "last_tap": counted[-1]["time"],
        }
        if len(counted) % 2 == 1:
            on_bus.append(student)
        else:
            off_bus.append(student)

    not_boarded = [
        {"user_id": user_id, "name": name}
        for user_id, name in sorted(bus["roster"].items(), key=lambda item: item[1])
        if user_id not in taps_by_student
    ]
    return on_bus, off_bus, not_boarded


# ------------------------------------------------------------- webhook ----

def signature_ok(raw_body, header):
    """Verkada-Signature is "<timestamp>|<hex hmac>". Signed bytes are body|timestamp."""
    if not header or "|" not in header:
        return False
    ts, sig = header.split("|", 1)
    if not ts.isdigit() or abs(time.time() - int(ts)) > MAX_SIGNATURE_AGE:
        return False
    expected = hmac.new(SECRET.encode(), raw_body + b"|" + ts.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


app = FastAPI()


@app.post("/webhook")
async def webhook(request: Request):
    raw = await request.body()
    if not signature_ok(raw, request.headers.get("verkada-signature")):
        return JSONResponse({"error": "bad signature"}, status_code=403)

    try:
        data = json.loads(raw).get("data") or {}
    except json.JSONDecodeError:
        return JSONResponse({"error": "not json"}, status_code=400)

    # Everything we don't use gets a 200 so Verkada doesn't retry it.
    kind = data.get("notification_type")
    if kind not in BOARDING_EVENTS and kind not in REJECTED_EVENTS:
        return {"ok": True, "ignored": kind}

    door_id = data.get("door_id")
    if not door_id:
        return {"ok": True, "ignored": "no door_id"}

    # A door we haven't seen yet becomes a bus, named from the webhook.
    if door_id not in state["buses"]:
        door_name = (data.get("door_info") or {}).get("name") or door_id
        state["buses"][door_id] = new_bus(door_name)
        save_state()
    bus = state["buses"][door_id]

    if not route_active(bus):
        return {"ok": True, "ignored": "no active route on this bus"}

    user = data.get("user_info") or {}
    tap_time = data.get("created")
    if not data.get("event_id") or tap_time is None:
        return {"ok": True, "ignored": "missing event_id or created"}
    if tap_time < bus["route"]["started_at"]:
        return {"ok": True, "ignored": "tap before route started"}

    # Rejected tap: record an alert. user_id is None for a card assigned to nobody.
    if kind in REJECTED_EVENTS:
        bus["alerts"][data["event_id"]] = {
            "user_id": user.get("user_id"),
            "name": user.get("name"),
            "card": data.get("input_value"),
            "time": tap_time,
        }
        save_state()
        print(f"[alert] {bus['name']}: rejected tap user_id={user.get('user_id')} time={tap_time}")
        return {"ok": True}

    # Accepted tap. Keyed by event_id, so the same tap delivered twice only counts once.
    if not user.get("user_id"):
        return {"ok": True, "ignored": "accepted tap with no user_id"}
    bus["taps"][data["event_id"]] = {
        "user_id": user["user_id"],
        "name": user.get("name") or "(no name)",
        "time": tap_time,
    }
    save_state()
    print(f"[tap] {bus['name']}: user_id={user['user_id']} time={tap_time}")
    return {"ok": True}


# ---------------------------------------------------------- page + api ----

@app.get("/")
async def page():
    return FileResponse(HERE / "index.html")


@app.get("/buses")
async def buses():
    """One summary line per bus, for the overview."""
    summary = []
    for door_id, bus in state["buses"].items():
        on_bus, off_bus, not_boarded = compute_manifest(bus)
        summary.append({
            "door_id": door_id,
            "name": bus["name"],
            "route": bus["route"],
            "on_bus": len(on_bus),
            "not_boarded": len(not_boarded),
            "alerts": len(bus["alerts"]),
        })
    summary.sort(key=lambda b: b["name"])
    return summary


@app.get("/bus/{door_id}")
async def bus_manifest(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    on_bus, off_bus, not_boarded = compute_manifest(bus)
    alerts = sorted(bus["alerts"].values(), key=lambda a: a["time"], reverse=True)
    return {
        "door_id": door_id,
        "name": bus["name"],
        "route": bus["route"],
        "on_bus": on_bus,
        "off_bus": off_bus,
        "not_boarded": not_boarded,
        "alerts": alerts,
    }


@app.post("/bus/{door_id}/route/start")
async def start_route(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    # Starting a route throws away this bus's previous taps and alerts (no history yet).
    bus["route"] = {"started_at": int(time.time()), "ended_at": None}
    bus["taps"] = {}
    bus["alerts"] = {}
    save_state()
    return {"ok": True}


@app.post("/bus/{door_id}/route/end")
async def end_route(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    if route_active(bus):
        bus["route"]["ended_at"] = int(time.time())
        save_state()
    return {"ok": True}


@app.post("/roster/refresh")
async def refresh_roster():
    # The API calls take a few seconds. Run them on a worker thread so webhooks
    # keep being answered meanwhile; fetch_buses only returns data and never
    # touches `state`, so there's nothing to lock.
    try:
        fetched = await asyncio.to_thread(verkada_api.fetch_buses)
    except Exception as e:
        print(f"[roster] refresh failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=502)

    # Back on the main thread: merge. Taps, alerts and routes are kept.
    for door_id, info in fetched.items():
        bus = state["buses"].setdefault(door_id, new_bus(info["name"]))
        if info["name"] != door_id:          # keep a webhook name if the API gave none
            bus["name"] = info["name"]
        bus["roster"] = info["roster"]
    save_state()
    return {"ok": True, "buses": len(fetched)}
