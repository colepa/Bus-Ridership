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
import httpx
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

import verkada_api  # after load_dotenv, so it sees VERKADA_REGION

SECRET = os.environ["VERKADA_WEBHOOK_SECRET"]
STATE_FILE = HERE / "state.json"
PHOTOS = HERE / "photos"   # <user_id>.jpg profile photos from Command, filled by "Refresh roster"

DEBOUNCE_SECONDS = 3       # a second tap by the same student within this is ignored
MAX_SIGNATURE_AGE = 60      # seconds; matches Verkada's own sample
BOARDING_EVENTS = {"door_keycard_entered_accepted"}
REJECTED_EVENTS = {"door_keycard_entered_rejected"}

# Parent texts. Off unless SMS_ENABLED=true in .env; when off, the text is printed instead.
# parents.json = {"<user_id>": "+15551234567"} — only these students get texts (gitignored).
SMS_ENABLED = os.environ.get("SMS_ENABLED", "").lower() == "true"
PARENTS_FILE = HERE / "parents.json"


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
#             # Issues someone pressed "Resolve" on, this route: {issue key: time}.
#             # Keys: "alert:<event_id>", "wrong_bus:<user_id>", "never_off:<user_id>".
#             # Resolved issues leave "Needs attention" but are kept for the record.
#             "resolved": {"wrong_bus:<user_id>": 1791847900},
#             # Everything the driver did on the driver page, this route, oldest first.
#             # Board/unboard also adds a tap to "taps" (key "driver-<n>", "override": True),
#             # so the on/off toggle works as usual. Dismiss also sets "resolved".
#             # camera_id + time = the clip of the moment the driver pressed the button.
#             "driver_log": [
#                 {"action": "board" | "unboard" | "dismiss", "time": 1791847950,
#                  "user_id": "..." or None, "name": "...", "camera_id": "..." or None,
#                  "key": "alert:<event_id>", "title": "Card rejected"},   # dismiss only
#             ],
#         },
#     },
#     # Finished routes, oldest first. "Start route" moves the bus's previous
#     # route here (with a copy of the roster at the time) before clearing it.
#     # This is what student lookup reads. "demo": True marks made-up history
#     # from `simulate.py history`.
#     "past_routes": [
#         {"door_id": "...", "bus_name": "Bus 12", "started_at": ..., "ended_at": ...,
#          "roster": {...}, "taps": {...}, "alerts": {...}, "resolved": {...}, "driver_log": [...]},
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
            for bus in loaded["buses"].values():
                bus.setdefault("resolved", {})   # state.json from before "Resolve" existed
                bus.setdefault("driver_log", [])  # ...and before the driver page
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
    return {"name": name, "route": None, "taps": {}, "alerts": {}, "roster": {}, "resolved": {},
            "driver_log": [], "camera_id": None}


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
    Driver overrides always count: the driver pressed a button on purpose.
    """
    by_student = {}
    for tap in sorted(taps.values(), key=lambda t: t["time"]):
        mine = by_student.setdefault(tap["user_id"], [])
        if mine and not tap.get("override") and tap["time"] - mine[-1]["time"] < DEBOUNCE_SECONDS:
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
            # True if that tap was the driver pressing Board/Unboard, not a card.
            "on_override": bool(counted[0].get("override")),
            "last_override": bool(counted[-1].get("override")),
            "wrong_bus": bool(bus["roster"]) and user_id not in bus["roster"],
            # Still on the bus at the end, then someone pressed "Mark as dropped off":
            # the time they pressed it. Counts as off the bus.
            "marked_off": None if route_active(bus) else bus["resolved"].get(f"never_off:{user_id}"),
        }
        if len(counted) % 2 == 1 and not student["marked_off"]:
            on_bus.append(student)
        else:
            off_bus.append(student)

    not_boarded = [
        {"user_id": user_id, "name": name}
        for user_id, name in sorted(bus["roster"].items(), key=lambda item: item[1])
        if user_id not in taps_by_student
    ]
    return on_bus, off_bus, not_boarded


def list_flags(bus, on_bus, off_bus):
    """Unresolved things a dispatcher should look at: rejected scans, wrong-bus
    riders, and (once the route has ended) anyone who never tapped off.
    Returns [{"key", "title", "who", "time"}, ...], newest first.
    The keys match the ones the bus page sends to /resolve."""
    flags = []
    for event_id, a in bus["alerts"].items():
        if a["user_id"]:
            flags.append({"key": f"alert:{event_id}", "title": "Card rejected",
                          "who": a["name"], "time": a["time"]})
        else:
            flags.append({"key": f"alert:{event_id}", "title": "Unrecognized card",
                          "who": f"Card {a['card']}", "time": a["time"]})
    for s in on_bus + off_bus:
        if s["wrong_bus"]:
            flags.append({"key": f"wrong_bus:{s['user_id']}", "title": "Wrong bus",
                          "who": s["name"], "time": s["on_at"]})
    if bus["route"] is not None and not route_active(bus):
        for s in on_bus:
            if not s["wrong_bus"]:
                flags.append({"key": f"never_off:{s['user_id']}", "title": "Never tapped off",
                              "who": s["name"], "time": s["on_at"]})
    flags = [f for f in flags if f["key"] not in bus["resolved"]]
    flags.sort(key=lambda f: f["time"], reverse=True)
    return flags


def count_flags(bus, on_bus, off_bus):
    return len(list_flags(bus, on_bus, off_bus))


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
            "resolved": bus["resolved"], "driver_log": bus["driver_log"],
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
    resolved = route.get("resolved", {})   # routes saved before "Resolve" existed have none
    rows = []

    taps = counted_taps(route["taps"]).get(user_id, [])
    for i in range(0, len(taps), 2):        # pairs: (on, off)
        on = taps[i]["time"]
        off = taps[i + 1]["time"] if i + 1 < len(taps) else None
        cameras = {"on_camera": clip_camera(taps[i], bus),
                   "off_camera": clip_camera(taps[i + 1], bus) if off else None,
                   # set by the driver page (Board / Unboard), not a card scan
                   "on_override": bool(taps[i].get("override")),
                   "off_override": bool(off and taps[i + 1].get("override"))}
        resolved_at = None
        if route["roster"] and not assigned:
            status = "wrong_bus"
            resolved_at = resolved.get(f"wrong_bus:{user_id}")
        elif off is not None:
            status = "dropped_off"
        elif route["ended_at"] is None:
            status = "aboard"
        else:
            status = "left_on_bus"
            resolved_at = resolved.get(f"never_off:{user_id}")
            if resolved_at:
                status = "dropped_off"   # marked as dropped off by hand; no off tap
        rows.append({**base, **cameras, "on": on, "off": off, "status": status,
                     "resolved_at": resolved_at})

    for event_id, alert in route["alerts"].items():
        if alert["user_id"] == user_id:
            rows.append({**base, "on": alert["time"], "on_camera": clip_camera(alert, bus),
                         "status": "rejected", "resolved_at": resolved.get(f"alert:{event_id}")})

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


# ---------------------------------------------------------- parent SMS ----

def parent_phone(user_id):
    """The phone number to text for this student, or None. Re-read every time,
    so edits to parents.json apply without a restart."""
    if not PARENTS_FILE.exists():
        return None
    return json.loads(PARENTS_FILE.read_text()).get(user_id)


def tap_direction(bus, event_id, user_id):
    """"on" or "off" for this tap, or None if it doesn't count (a debounced double tap)."""
    counted = counted_taps(bus["taps"]).get(user_id, [])
    position = next((i for i, t in enumerate(counted, 1) if t is bus["taps"][event_id]), None)
    if position is None:
        return None
    return "on" if position % 2 == 1 else "off"


def tap_text(bus, event_id, user_id):
    """The parent text for this tap, e.g. "Ava Smith got on Bus 1 at 7:42 AM.",
    or None if the tap doesn't count (a debounced double tap)."""
    on_or_off = tap_direction(bus, event_id, user_id)
    if on_or_off is None:
        return None
    name = bus["roster"].get(user_id) or bus["taps"][event_id]["name"]
    at = time.strftime("%-I:%M %p", time.localtime(bus["taps"][event_id]["time"]))
    return f"{name} got {on_or_off} {bus['name']} at {at}."


async def send_sms(to, body):
    """Send one text through Twilio. Runs after the webhook has replied, so a
    slow or failed send never delays or breaks a tap."""
    if not SMS_ENABLED:
        print(f"[sms off] to {to}: {body}")
        return
    sid = os.environ["TWILIO_ACCOUNT_SID"]
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, auth=(sid, os.environ["TWILIO_AUTH_TOKEN"]),
                                  data={"To": to, "From": os.environ["TWILIO_FROM"], "Body": body})
        if r.status_code >= 300:
            print(f"[sms] Twilio said {r.status_code}: {r.text}")
        else:
            print(f"[sms] sent to {to}: {body}")
    except Exception as e:
        print(f"[sms] failed: {e}")


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
async def webhook(request: Request, background: BackgroundTasks):
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
        notify(door_id, {"kind": "rejected", "user_id": user.get("user_id"), "name": user.get("name"),
                         "card": data.get("input_value"), "time": tap_time,
                         "assigned": assigned_buses(user["user_id"]) if user.get("user_id") else []})
        return {"ok": True}

    # Accepted tap. Keyed by event_id, so the same tap delivered twice only counts once.
    if not user.get("user_id"):
        return {"ok": True, "ignored": "accepted tap with no user_id"}
    already_seen = data["event_id"] in bus["taps"]   # Verkada retried; don't text twice
    bus["taps"][data["event_id"]] = {
        "user_id": user["user_id"],
        "name": user.get("name") or "(no name)",
        "time": tap_time,
        "camera_id": camera_id,
    }
    save_state()
    print(f"[tap] {bus['name']}: user_id={user['user_id']} time={tap_time}")

    # Tell the driver page. A retry or a debounced double tap only refreshes
    # the list; a counted tap also shows the big name + photo.
    direction = tap_direction(bus, data["event_id"], user["user_id"])
    if direction and not already_seen:
        notify(door_id, {"kind": direction, "user_id": user["user_id"],
                         "name": bus["roster"].get(user["user_id"]) or user.get("name") or "(no name)",
                         "time": tap_time,
                         "wrong_bus": bool(bus["roster"]) and user["user_id"] not in bus["roster"],
                         "assigned": assigned_buses(user["user_id"])})
    else:
        notify(door_id, {"kind": "changed"})

    phone = parent_phone(user["user_id"])
    text = tap_text(bus, data["event_id"], user["user_id"])
    if phone and text and not already_seen:
        background.add_task(send_sms, phone, text)
    return {"ok": True}


# ---------------------------------------------------------- page + api ----

@app.get("/")
async def page():
    return FileResponse(HERE / "index.html")


@app.get("/bus.png")
async def bus_picture():
    return FileResponse(HERE / "bus.png")


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
            # roster students only (no wrong-bus riders), for the progress bar
            "roster_on": sum(1 for s in on_bus if not s["wrong_bus"]),
            "roster_off": sum(1 for s in off_bus if not s["wrong_bus"]),
            "flags": count_flags(bus, on_bus, off_bus),
            "issues": list_flags(bus, on_bus, off_bus),   # for the hover preview
        })
    summary.sort(key=lambda b: b["name"])
    return summary


@app.get("/bus/{door_id}")
async def bus_manifest(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    on_bus, off_bus, not_boarded = compute_manifest(bus)
    # Copies with "assigned" added, so the page can say "assigned to Bus 3",
    # and the event_id, which the page needs for the alert's resolve key.
    alerts = [
        {**a, "event_id": event_id,
         "assigned": assigned_buses(a["user_id"]) if a["user_id"] else [],
         "camera_id": clip_camera(a, bus)}
        for event_id, a in sorted(bus["alerts"].items(), key=lambda item: item[1]["time"], reverse=True)
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
        "resolved": bus["resolved"],
        "driver_log": bus["driver_log"],
        "flags": count_flags(bus, on_bus, off_bus),
    }


@app.post("/bus/{door_id}/resolve")
async def resolve(door_id: str, request: Request):
    """Mark one "Needs attention" issue as dealt with. Body: {"key": "..."}
    (see the "resolved" comment at the top). Kept with the route for the record."""
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    key = (await request.json()).get("key")
    if not key:
        return JSONResponse({"error": "missing key"}, status_code=400)
    bus["resolved"].setdefault(key, int(time.time()))
    save_state()
    notify(door_id, {"kind": "changed"})
    return {"ok": True}


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
            "resolved": bus["resolved"], "driver_log": bus["driver_log"],
        })
    bus["route"] = {"started_at": int(time.time()), "ended_at": None}
    bus["taps"] = {}
    bus["alerts"] = {}
    bus["resolved"] = {}
    bus["driver_log"] = []
    save_state()
    notify(door_id, {"kind": "changed"})
    return {"ok": True}


@app.post("/bus/{door_id}/route/end")
async def end_route(door_id: str):
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    if route_active(bus):
        bus["route"]["ended_at"] = int(time.time())
        save_state()
        notify(door_id, {"kind": "changed"})
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
    for door_id in fetched:
        notify(door_id, {"kind": "changed"})

    # Profile photos, saved as photos/<user_id>.jpg. A failure here (e.g. the
    # API key can't read photos) doesn't undo the roster; the page says so.
    # Who: everyone on a Command roster, plus anyone on no roster who has
    # tapped (wrong bus, rejected) — so an unexpected rider has a face too.
    # Not every user in the org: a district has thousands of staff cards.
    user_ids = {u for info in fetched.values() for u in info["roster"]}
    on_any_roster = {u for bus in state["buses"].values() for u in bus["roster"]}
    user_ids |= set(all_students()) - on_any_roster
    try:
        photos = await asyncio.to_thread(verkada_api.fetch_photos, sorted(user_ids))
    except Exception as e:
        print(f"[photos] refresh failed: {e}")
        return {"ok": True, "buses": len(fetched), "photo_error": str(e)}
    PHOTOS.mkdir(exist_ok=True)
    for user_id in user_ids:
        path = PHOTOS / f"{user_id}.jpg"
        if user_id in photos:
            path.write_bytes(photos[user_id])
        else:
            path.unlink(missing_ok=True)     # photo removed in Command
    return {"ok": True, "buses": len(fetched), "photos": len(photos)}


@app.get("/photos")
async def photo_list():
    """{user_id: version} for everyone with a saved photo. The version (file
    time) goes in the image URL, so a new photo isn't hidden by the browser cache."""
    if not PHOTOS.exists():
        return {}
    return {p.stem: int(p.stat().st_mtime) for p in PHOTOS.glob("*.jpg")}


@app.get("/photo/{user_id}")
async def photo(user_id: str):
    path = PHOTOS / f"{user_id}.jpg"
    if not path.is_file():
        return JSONResponse({"error": "no photo"}, status_code=404)
    # Cached for a day: the page polls every 2 s and would re-fetch otherwise.
    return FileResponse(path, headers={"Cache-Control": "max-age=86400"})


# --------------------------------------------------------- driver page ----
#
# driver.html, on the bus's iPad. Only ever uses endpoints under /driver/
# (plus /photo), so a sign-in later can allow drivers /driver/<their bus>/...
# and nothing else.
#
# Live updates are pushed, not polled: the page keeps one /driver/<bus>/events
# connection open (server-sent events) and the server writes a line to it
# whenever something happens on that bus. Over ngrok that's one request per
# page load instead of one every 2 s, and the scan shows up instantly.

listeners = {}   # {door_id: [asyncio.Queue, ...]}, one queue per open driver page


def notify(door_id, event):
    """Push an event to every driver page open on this bus.
    {"kind": "on" | "off" | "rejected", ...} = a scan (shown big on screen);
    {"kind": "changed"} = something else changed, just reload the list."""
    for queue in listeners.get(door_id, []):
        queue.put_nowait(event)


@app.get("/driver")
async def driver_page_pick():
    return FileResponse(HERE / "driver.html")


@app.get("/driver/buses")
async def driver_buses():
    """For the bus picker: [{door_id, name}]."""
    return sorted(({"door_id": d, "name": b["name"]} for d, b in state["buses"].items()),
                  key=lambda b: b["name"])


@app.get("/driver/{door_id}")
async def driver_page(door_id: str):
    return FileResponse(HERE / "driver.html")


@app.get("/driver/{door_id}/state")
async def driver_state(door_id: str):
    """Everything the driver page draws: every student with their status, and the open issues."""
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    on_bus, off_bus, not_boarded = compute_manifest(bus)

    students = []
    for s in on_bus:
        students.append({"user_id": s["user_id"], "name": s["name"], "status": "aboard",
                         "since": s["last_tap"], "override": s["last_override"], "wrong_bus": s["wrong_bus"]})
    for s in off_bus:
        students.append({"user_id": s["user_id"], "name": s["name"], "status": "dropped_off",
                         "since": s["marked_off"] or s["last_tap"], "override": s["last_override"],
                         "wrong_bus": s["wrong_bus"]})
    for s in not_boarded:
        students.append({"user_id": s["user_id"], "name": s["name"], "status": "not_boarded",
                         "since": None, "override": False, "wrong_bus": False})
    students.sort(key=lambda s: s["name"])

    times = [t["time"] for t in bus["taps"].values() if not t.get("override")]
    times += [a["time"] for a in bus["alerts"].values()]
    return {
        "door_id": door_id,
        "name": bus["name"],
        "route": bus["route"],
        "students": students,
        "issues": list_flags(bus, on_bus, off_bus),
        "last_scan": max(times) if times else None,
        # Everyone's photo versions (same as /photos), so a wrong-bus rider has a face
        # too, and the page needs one request per update instead of two.
        "photos": await photo_list(),
    }


@app.get("/driver/{door_id}/events")
async def driver_events(door_id: str):
    """Server-sent events: one line per event, "data: {...json...}", for as long
    as the page stays open. A comment line every 15 s keeps the connection
    from being closed as idle (ngrok, iPad). The browser reconnects by itself."""
    queue = asyncio.Queue()
    listeners.setdefault(door_id, []).append(queue)

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": still here\n\n"
        finally:   # page closed: stop sending to it
            listeners[door_id].remove(queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


@app.post("/driver/{door_id}/override")
async def driver_override(door_id: str, request: Request):
    """The driver boards or unboards a student by hand. Body: {"user_id", "action": "board" | "unboard"}.

    Saved as an extra tap marked "override", so the usual on/off toggle does
    the rest, and logged in driver_log with the door camera, for the clip.
    """
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    if not route_active(bus):
        return JSONResponse({"error": "No route running. Start the route first."}, status_code=409)
    body = await request.json()
    user_id, action = body.get("user_id"), body.get("action")
    if action not in ("board", "unboard"):
        return JSONResponse({"error": "action must be board or unboard"}, status_code=400)

    on_bus, off_bus, not_boarded = compute_manifest(bus)
    everyone = {s["user_id"]: s["name"] for s in on_bus + off_bus + not_boarded}
    if user_id not in everyone:
        return JSONResponse({"error": "not on this bus"}, status_code=404)
    aboard = any(s["user_id"] == user_id for s in on_bus)
    # Checked here, not just on the page: two quick presses (or a page that's
    # a moment out of date) mustn't toggle the student twice.
    if action == "board" and aboard:
        return JSONResponse({"error": f"{everyone[user_id]} is already aboard"}, status_code=409)
    if action == "unboard" and not aboard:
        return JSONResponse({"error": f"{everyone[user_id]} isn't aboard"}, status_code=409)

    now = int(time.time())
    bus["taps"][f"driver-{len(bus['driver_log'])}"] = {
        "user_id": user_id, "name": everyone[user_id], "time": now,
        "camera_id": bus.get("camera_id"), "override": True,
    }
    bus["driver_log"].append({"action": action, "time": now, "user_id": user_id,
                              "name": everyone[user_id], "camera_id": bus.get("camera_id")})
    save_state()
    print(f"[driver] {bus['name']}: {action} {everyone[user_id]}")
    notify(door_id, {"kind": "changed"})
    return {"ok": True}


@app.post("/driver/{door_id}/dismiss")
async def driver_dismiss(door_id: str, request: Request):
    """The driver dismisses one open issue. Body: {"key": "..."}, same keys as
    /bus/<door_id>/resolve. Same effect, plus a driver_log entry with the clip."""
    bus = state["buses"].get(door_id)
    if bus is None:
        return JSONResponse({"error": "no such bus"}, status_code=404)
    key = (await request.json()).get("key")
    on_bus, off_bus, _ = compute_manifest(bus)
    issue = next((f for f in list_flags(bus, on_bus, off_bus) if f["key"] == key), None)
    if issue is None:
        return JSONResponse({"error": "That issue is already resolved."}, status_code=409)

    now = int(time.time())
    bus["resolved"][key] = now
    if key.startswith("alert:"):    # None for a card linked to nobody
        user_id = bus["alerts"][key.removeprefix("alert:")]["user_id"]
    else:                           # "wrong_bus:<user_id>" / "never_off:<user_id>"
        user_id = key.split(":", 1)[1]
    bus["driver_log"].append({"action": "dismiss", "time": now, "user_id": user_id,
                              "name": issue["who"], "camera_id": bus.get("camera_id"),
                              "key": key, "title": issue["title"]})
    save_state()
    print(f"[driver] {bus['name']}: dismissed {issue['title']} ({issue['who']})")
    notify(door_id, {"kind": "changed"})
    return {"ok": True}


@app.post("/driver/{door_id}/route/{action}")
async def driver_route(door_id: str, action: str):
    """Start / End route from the driver page. Same as the manager page's buttons."""
    if action == "start":
        return await start_route(door_id)
    if action == "end":
        return await end_route(door_id)
    return JSONResponse({"error": "action must be start or end"}, status_code=400)
