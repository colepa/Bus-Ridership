"""API probe: pull recent access-control events from GET /v2/events.

This is what backfill will use later. For now: fetch, save, print a summary.

Run (from the project root):
    uv run python tools/verkada-probe/events_probe.py            # last 1 hour
    uv run python tools/verkada-probe/events_probe.py 24         # last 24 hours
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Project-root .env, found from this file's location so the working directory doesn't matter.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
API_KEY = os.environ["VERKADA_API_KEY"]
BASE = f"https://{os.getenv('VERKADA_REGION', 'api')}.verkada.com"
CAPTURES = Path(__file__).parent / "captures"
CAPTURES.mkdir(exist_ok=True)


def get_token():
    """Swap the API key for a 30-minute token."""
    r = httpx.post(f"{BASE}/token", headers={"x-api-key": API_KEY})
    r.raise_for_status()
    return r.json()["token"]


def get_events(token, hours):
    """Fetch every access-control event in the last `hours`, following the cursor."""
    start = datetime.now(timezone.utc) - timedelta(hours=hours)
    params = {
        "product_types": "access_control",
        "start_time": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "limit": 200,
    }
    events = []
    while True:
        r = httpx.get(f"{BASE}/v2/events", headers={"x-verkada-auth": token}, params=params)
        if r.status_code != 200:
            print(f"HTTP {r.status_code}: {r.text}")
            r.raise_for_status()
        page = r.json()
        events += page.get("items", [])
        if not page.get("cursor"):
            return events
        params["cursor"] = page["cursor"]


def main():
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 1
    events = get_events(get_token(), hours)

    path = CAPTURES / f"events-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(events, indent=2))

    print(f"{len(events)} access events in the last {hours}h -> {path}")
    for e in events:
        info = e.get("event_info") or {}
        user = info.get("user_info") or {}
        print(
            f"  {e['timestamp']}  {e['event_type']:28} "
            f"user_id={user.get('user_id')} direction={info.get('direction')} "
            f"door={info.get('door_name')}"
        )


if __name__ == "__main__":
    main()
