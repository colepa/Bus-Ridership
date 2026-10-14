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
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

import verkada_api  # after load_dotenv, so it sees VERKADA_REGION

SECRET = os.environ["VERKADA_WEBHOOK_SECRET"]
STATE_FILE = HERE / "state.json"

DEBOUNCE_SECONDS = 3       # a second tap by the same student within this is ignored
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
#     # Finished routes, oldest first. "Start route" moves the bus's previous
#     # route here (with a copy of the roster at the time) before clearing it.
#     # This is what student lookup reads. "demo": True marks made-up history
#     # from `simulate.py history`.
#     "past_routes": [
#         {"door_id": "...", "bus_name": "Bus 12", "started_at": ..., "ended_at": ...,
#          "roster": {...}, "taps": {...}, "alerts": {...}},
#     ],
# }
#
# All endpoints below are `async def`, so FastAPI runs them one at a time on a
# single thread — no locking needed around this dict.

def load_state():
    if STATE_FILE.exists():
        loaded = json.loads(STATE_FILE.read_text())
        if "buses" in loaded:
            loaded.setdefault("past_routes", [])
            return loaded
        # state.json from the single-bus version: start fresh (it's a demo).
    return {"buses": {}, "past_routes": []}


def save_state():
    # Write to a temp file then rename, so a crash mid-write can't leave half a file.
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)


state = load_state()


def add_fake_buses():
    """Make sure the made-up buses in fake_buses.json exist, with their rosters.

    They aren't doors in Command, so "Refresh roster" never touches them.
    Taps come from fake_tap.py / simulate.py. Delete the file to drop them
    (and remove their entries from state.json).
    """
    path = HERE / "fake_buses.json"
    if not path.exists():
        return
    for door_id, info in json.loads(path.read_text()).items():
        bus = state["buses"].setdefault(door_id, new_bus(info["name"]))
        bus["name"] = info["name"]
        bus["roster"] = info["roster"]
        bus["camera_id"] = info.get("camera_id")   # optional: borrow a real camera for demo clips
    save_state()


def new_bus(name):
    return {"name": name, "route": None, "taps": {}, "alerts": {}, "roster": {}, "camera_id": None}


def clip_camera(tap, bus):
    """Camera for a tap's clip: the one the webhook named, else the bus's camera.
    The fallback is what gives fake buses and made-up history clips."""
    return tap.get("camera_id") or bus.get("camera_id")


add_fake_buses()


def route_active(bus):
    return bus["route"] is not None and bus["route"]["ended_at"] is None


# ------------------------------------------------------------ manifest ----

def counted_taps(taps):
    """Group taps by student: {user_id: [tap, ...]}, oldest first.

    A tap within DEBOUNCE_SECONDS of that student's previous counted tap is
    dropped (an accidental double tap). Taps 1, 3, 5... are "on", 2, 4... "off".
    """
    by_student = {}
    for tap in sorted(taps.values(), key=lambda t: t["time"]):
        mine = by_student.setdefault(tap["user_id"], [])
        if mine and tap["time"] - mine[-1]["time"] < DEBOUNCE_SECONDS:
            continue
        mine.append(tap)
    return by_student


def compute_manifest(bus):
    """Return (on_bus, off_bus, not_boarded) lists of students for one bus.

    Odd number of counted taps = on the bus, even = off.
    not_boarded = on the roster, no accepted tap this route.
    wrong_bus = tapped on but not on this bus's roster.
    """
    taps_by_student = counted_taps(bus["taps"])

    on_bus, off_bus = [], []
    for user_id, counted in taps_by_student.items():
        student = {
            "user_id": user_id,
            "name": bus["roster"].get(user_id) or counted[-1]["name"],
            "taps": len(counted),
            "on_at": counted[0]["time"],
            "last_tap": counted[-1]["time"],
            "on_camera": clip_camera(counted[0], bus),
            "last_camera": clip_camera(counted[-1], bus),
            "wrong_bus": bool(bus["roster"]) and user_id not in bus["roster"],
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


def count_flags(bus, on_bus, off_bus):
    """Things a dispatcher should look at: rejected scans, wrong-bus riders,
    and (once the route has ended) anyone who never tapped off."""
    flags = len(bus["alerts"])
    flags += sum(1 for s in on_bus + off_bus if s["wrong_bus"])
    if bus["route"] is not None and not route_active(bus):
        flags += sum(1 for s in on_bus if not s["wrong_bus"])
    return flags


def assigned_buses(user_id):
    """Names of the buses whose roster has this student."""
    return [bus["name"] for bus in state["buses"].values() if user_id in bus["roster"]]


# ------------------------------------------------------- student lookup ----

def current_routes():
    """Each bus's current route (running or ended, not yet replaced), in the
    same shape as an entry of state["past_routes"]."""
    routes = []
    for door_id, bus in state["buses"].items():
        if bus["route"] is None:
            continue
        routes.append({
            "door_id": door_id, "bus_name": bus["name"],
            "started_at": bus["route"]["started_at"], "ended_at": bus["route"]["ended_at"],
            "roster": bus["roster"], "taps": bus["taps"], "alerts": bus["alerts"],
        })
    return routes


def student_rows(route, user_id):
    """What happened to one student on one route, as rows for the history table.

    Usually one row. A student who rode twice on one route gets two; a student
    with nothing to do with this route gets none.
    """
    base = {"door_id": route["door_id"], "bus_name": route["bus_name"],
            "route_started": route["started_at"],
            "on": None, "off": None, "on_camera": None, "off_camera": None}
    bus = state["buses"].get(route["door_id"]) or {}
    assigned = user_id in route["roster"]
    rows = []

    taps = counted_taps(route["taps"]).get(user_id, [])
    for i in range(0, len(taps), 2):        # pairs: (on, off)
        on = taps[i]["time"]
        off = taps[i + 1]["time"] if i + 1 < len(taps) else None
        cameras = {"on_camera": clip_camera(taps[i], bus),
                   "off_camera": clip_camera(taps[i + 1], bus) if off else None}
        if route["roster"] and not assigned:
            status = "wrong_bus"
        elif off is not None:
            status = "dropped_off"
        elif route["ended_at"] is None:
            status = "aboard"
        else:
            status = "left_on_bus"
        rows.append({**base, **cameras, "on": on, "off": off, "status": status})

    for alert in route["alerts"].values():
        if alert["user_id"] == user_id:
            rows.append({**base, "on": alert["time"], "on_camera": clip_camera(alert, bus),
                         "status": "rejected"})

    if not rows and assigned:
        rows.append({**base, "status": "not_boarded" if route["ended_at"] is None else "no_show"})
    return rows


def all_students():
    """Everyone we know about: every roster, plus anyone who has ever tapped."""
    students = {}
    for bus in state["buses"].values():
        for user_id, name in bus["roster"].items():
            students.setdefault(user_id, {"user_id": user_id, "name": name, "buses": []})
            students[user_id]["buses"].append(bus["name"])
    for route in state["past_routes"] + current_routes():
        for tap in list(route["taps"].values()) + list(route["alerts"].values()):
            if tap.get("user_id") and tap["user_id"] not in students:
                students[tap["user_id"]] = {"user_id": tap["user_id"],
                                            "name": tap.get("name") or tap["user_id"],
                                            "buses": []}
    return students


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
        envelope = json.loads(raw)
    except json.JSONDecodeError:
        return JSONResponse({"error": "not json"}, status_code=400)
    data = envelope.get("data") or {}

    # The streaming API needs our org_id; the webhook is the easiest place to learn it.
    # (fake_tap.py sends org_id None, so fake taps never overwrite it.)
    if envelope.get("org_id") and state.get("org_id") != envelope["org_id"]:
        state["org_id"] = envelope["org_id"]
        save_state()

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

    # The camera linked to this door in Command (door settings -> cameras).
    # null until one is linked. Kept on the bus too, as the fallback for clips.
    camera_info = (data.get("door_info") or {}).get("camera_info") or {}
    camera_id = camera_info.get("inside_camera_id")
    if camera_id and bus.get("camera_id") != camera_id:
        bus["camera_id"] = camera_id
        save_state()

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
            "camera_id": camera_id,
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
        "camera_id": camera_id,
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
            "roster": len(bus["roster"]),
            "on_bus": len(on_bus),
            "off_bus": len(off_bus),
            "not_boarded": len(not_boarded),
            "flags": count_flags(bus, on_bus, off_bus),
        })
    summary.sort(key=lambda b: b["name"])
    return summary


@app.get("/bus/{door_id}")
async def bus_manifest(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    on_bus, off_bus, not_boarded = compute_manifest(bus)
    # Copies with "assigned" added, so the page can say "assigned to Bus 3".
    alerts = [
        {**a, "assigned": assigned_buses(a["user_id"]) if a["user_id"] else [],
         "camera_id": clip_camera(a, bus)}
        for a in sorted(bus["alerts"].values(), key=lambda a: a["time"], reverse=True)
    ]
    return {
        "door_id": door_id,
        "name": bus["name"],
        "route": bus["route"],
        "roster": [{"user_id": u, "name": n} for u, n in bus["roster"].items()],
        "on_bus": on_bus,
        "off_bus": off_bus,
        "not_boarded": not_boarded,
        "alerts": alerts,
        "flags": count_flags(bus, on_bus, off_bus),
    }


@app.get("/students")
async def students():
    """Everyone, for the search box: [{user_id, name, buses: [bus names]}]."""
    return sorted(all_students().values(), key=lambda s: s["name"])


@app.get("/student/{user_id}")
async def student(user_id: str):
    """One student's assigned buses, where they are now, and every past ride."""
    info = all_students().get(user_id)
    if info is None:
        return JSONResponse({"error": "no such student"}, status_code=404)

    now_rows = []
    for route in current_routes():
        if route["ended_at"] is None:
            now_rows += student_rows(route, user_id)

    history = []
    for route in state["past_routes"] + current_routes():
        history += student_rows(route, user_id)
    history.sort(key=lambda r: (r["route_started"], r["on"] or 0), reverse=True)

    return {
        "user_id": user_id,
        "name": info["name"],
        "buses": info["buses"],
        # Most important first: a student aboard somewhere beats "not boarded" elsewhere.
        "now": sorted(now_rows, key=lambda r: r["status"] != "aboard"),
        "history": history,
    }


# Clip length. Nothing is stored (footage is streamed from Verkada on each
# click), so a longer clip only means a slightly longer wait right after a scan.
# Verkada's stream comes in 4 s chunks, so playback can run up to ~3 s longer.
CLIP_BEFORE = 5   # seconds of footage before the scan
CLIP_AFTER = 5    # ...and after it. 10 s total.


@app.get("/clip/stream")
async def clip_stream(camera_id: str, at: int):
    """What the player needs for the clip around a scan: the playlist to load
    (served by /clip/playlist.m3u8 below), and `ready_in`, the seconds until the
    end of the clip has actually happened, so a click right after a scan waits.
    """
    if not state.get("org_id"):
        return JSONResponse({"error": "Don't know the org_id yet. Tap a real card once "
                                      "so the webhook tells us."}, status_code=409)
    end = at + CLIP_AFTER
    # +2 s of slack for the camera to finish writing the last bit.
    return {"url": f"/clip/playlist.m3u8?camera_id={camera_id}&at={at}",
            "ready_in": max(0, end + 2 - int(time.time()))}


@app.get("/clip/playlist.m3u8")
async def clip_playlist(camera_id: str, at: int):
    """Verkada's playlist for the clip, trimmed (see verkada_api.clip_playlist).
    The video chunks it lists are still fetched by the browser straight from Verkada."""
    try:
        text = await asyncio.to_thread(verkada_api.clip_playlist, state.get("org_id"),
                                       camera_id, at - CLIP_BEFORE, at + CLIP_AFTER)
    except Exception as e:
        print(f"[clip] playlist failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=502)
    return Response(text, media_type="application/vnd.apple.mpegurl")


@app.get("/clip")
async def clip(camera_id: str, at: int):
    """"Open in Command": send the browser to Command's video player at the scan.
    Asked for only when someone clicks, so webhooks stay fast."""
    try:
        url = await asyncio.to_thread(verkada_api.footage_link, camera_id, at - CLIP_BEFORE)
    except Exception as e:
        print(f"[clip] failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=502)
    return RedirectResponse(url)


@app.post("/demo/history")
async def demo_history(request: Request):
    """`simulate.py history` posts made-up past routes here.
    Replaces any made-up history from an earlier run; real routes are kept."""
    routes = await request.json()
    for route in routes:
        route["demo"] = True
    real = [r for r in state["past_routes"] if not r.get("demo")]
    state["past_routes"] = sorted(real + routes, key=lambda r: r["started_at"])
    save_state()
    return {"ok": True, "routes": len(routes)}


@app.post("/bus/{door_id}/route/start")
async def start_route(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    # Move the previous route (if anything happened on it) into history, then start clean.
    if bus["route"] is not None and (bus["taps"] or bus["alerts"]):
        state["past_routes"].append({
            "door_id": door_id, "bus_name": bus["name"],
            "started_at": bus["route"]["started_at"],
            "ended_at": bus["route"]["ended_at"] or int(time.time()),
            "roster": dict(bus["roster"]), "taps": bus["taps"], "alerts": bus["alerts"],
        })
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
