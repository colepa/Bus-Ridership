"""Send a signed fake Verkada tap to the local app, so you can test without the reader.

Usage (with the app running on port 8000):
    uv run python fake_tap.py <user_id> [name]
    uv run python fake_tap.py student-1 "Test Student One"

Optional: --door <door_id> to tap on a different bus (default: fake-bus-1).
    uv run python fake_tap.py fake-student-001 "Esme Reyes" --door fake-bus-2
Buses 2-4 and their students are in fake_buses.json. For a whole route, use simulate.py.
Use a real door_id (from the page URL after clicking a bus) to tap on that bus.

Optional: --type <notification_type> to send something other than an accepted tap.
    uv run python fake_tap.py student-2 "Test Student Two" --type door_keycard_entered_rejected
    uv run python fake_tap.py unknown --type door_keycard_entered_rejected   # card assigned to nobody
    uv run python fake_tap.py student-1 --type door_unlocked                 # should be ignored
"""

import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
SECRET = os.environ["VERKADA_WEBHOOK_SECRET"]
URL = "http://localhost:8000/webhook"


def pop_flag(args, flag, default):
    """Remove `--flag value` from args and return value (or default if absent)."""
    if flag not in args:
        return default
    i = args.index(flag)
    value = args[i + 1]
    del args[i:i + 2]
    return value


def send_tap(user_id, name, door_id, kind="door_keycard_entered_accepted"):
    """Post one signed fake event to the app. Returns the httpx response."""
    now = int(time.time())
    # Same shape as a real capture, trimmed to the fields the app reads.
    payload = {
        "org_id": None,   # so fake taps don't overwrite the real org_id the app learned
        "webhook_type": "notification",
        "created_at": now,
        "webhook_id": "fake-webhook",
        "data": {
            "notification_type": kind,
            "event_id": str(uuid.uuid4()),
            "created": now,
            "direction": None,
            "door_id": door_id,
            "door_info": {"door_id": door_id, "name": door_id},
            "input_value": "999|12345",
            # "unknown" = a card not assigned to anyone, so no user_info.
            "user_info": {} if user_id == "unknown" else {"user_id": user_id, "name": name},
        },
    }
    body = json.dumps(payload).encode()
    ts = str(now)
    sig = hmac.new(SECRET.encode(), body + b"|" + ts.encode(), hashlib.sha256).hexdigest()

    return httpx.post(URL, content=body, headers={
        "Content-Type": "application/json",
        "Verkada-Signature": f"{ts}|{sig}",
    })


def main():
    args = sys.argv[1:]
    kind = pop_flag(args, "--type", "door_keycard_entered_accepted")
    door_id = pop_flag(args, "--door", "fake-bus-1")
    if not args:
        print(__doc__)
        sys.exit(1)
    user_id = args[0]
    name = args[1] if len(args) > 1 else user_id

    r = send_tap(user_id, name, door_id, kind)
    print(r.status_code, r.text)


if __name__ == "__main__":
    main()
