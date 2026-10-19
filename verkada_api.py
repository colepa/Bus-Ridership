"""Calls to Verkada's Command API: "Refresh roster", and video clips when a
clip icon is clicked (short stream for the page, plus an "Open in Command" link).

fetch_buses() returns, for every door in the org:
    {"<door_id>": {"name": "Bus 12", "roster": {"<user_id>": "Student Name", ...}}}

Roster = everyone who has access to that door:
    access levels (door -> groups)  ->  groups (group -> users)  ->  users (user -> name)
Schedules on access levels are ignored: in a level means on the roster.

Needs VERKADA_API_KEY with read access to Access Control (doors, access levels,
groups, users).

fetch_photos() gets the roster's profile photos, also on "Refresh roster".
"""

import os
import time
from datetime import datetime
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

import httpx

BASE = f"https://{os.getenv('VERKADA_REGION', 'api')}.verkada.com"


def get_token():
    """Swap the API key for a 30-minute token."""
    r = httpx.post(f"{BASE}/token", headers={"x-api-key": os.environ["VERKADA_API_KEY"]})
    r.raise_for_status()
    return r.json()["token"]


def api_get(token, path, params=None):
    r = httpx.get(f"{BASE}{path}", headers={"x-verkada-auth": token}, params=params, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"GET {path} -> HTTP {r.status_code}: {r.text[:300]}")
    return r.json()


def fetch_buses():
    token = get_token()

    # Every door in the org is a bus.
    buses = {}
    for door in api_get(token, "/access/v1/doors").get("doors", []):
        # The docs don't list the id field on doors; try the likely names.
        door_id = door.get("door_id") or door.get("doorId") or door.get("id")
        if door_id:
            buses[door_id] = {"name": door.get("name") or door_id, "roster": {}}
        else:
            print(f"[roster] door with no id field, skipping: keys={sorted(door)}")

    # user_id -> name, for everyone.
    names = {}
    for member in api_get(token, "/access/v1/access_users").get("access_members", []):
        names[member["user_id"]] = member.get("full_name") or member["user_id"]

    # Access levels say which groups can open which doors.
    group_users = {}   # cache: each group is fetched once even if it's in several levels
    for level in api_get(token, "/access/v1/door/access_level").get("access_levels", []):
        for group_id in level.get("access_groups", []):
            if group_id not in group_users:
                group = api_get(token, "/access/v1/access_groups/group", {"group_id": group_id})
                group_users[group_id] = group.get("user_ids", [])
            for door_id in level.get("doors", []):
                bus = buses.setdefault(door_id, {"name": door_id, "roster": {}})
                for user_id in group_users[group_id]:
                    bus["roster"][user_id] = names.get(user_id, user_id)

    for door_id, bus in buses.items():
        print(f"[roster] {bus['name']}: {len(bus['roster'])} students")
    return buses


def fetch_photos(user_ids):
    """{user_id: image bytes} for each user who has a profile photo in Command.
    Users without one get a 404 and are left out. One call per user."""
    token = get_token()
    photos = {}
    for user_id in user_ids:
        r = httpx.get(f"{BASE}/access/v1/access_users/user/profile_photo",
                      headers={"x-verkada-auth": token}, params={"user_id": user_id}, timeout=20)
        if r.status_code == 200:
            photos[user_id] = r.content
        elif r.status_code != 404:
            raise RuntimeError(f"GET profile_photo -> HTTP {r.status_code}: {r.text[:300]}")
    print(f"[photos] {len(photos)} of {len(user_ids)} users have a photo")
    return photos


def footage_link(camera_id, timestamp):
    """Command URL that plays this camera's footage from `timestamp` (epoch seconds).
    Needs Cameras permission on the API key. The viewer must be logged in to Command."""
    token = get_token()
    return api_get(token, "/cameras/v1/footage/link",
                   {"camera_id": camera_id, "timestamp": timestamp})["url"]


stream_jwt = {"jwt": None, "fetched_at": 0}   # reused across clips, see below


def get_stream_jwt():
    """Token for the streaming endpoint. Needs the "Streaming - Live/Historical"
    permission on the API key. Per the docs this call takes the API key itself.

    Tokens last 30 min, and Verkada caps how many unexpired ones exist at once
    (HTTP 429 "Number of active (unexpired) tokens exceeds the limit"). So one
    token is reused for 25 min, then replaced, with 5 min to spare before it expires.
    """
    if stream_jwt["jwt"] and time.time() - stream_jwt["fetched_at"] < 25 * 60:
        return stream_jwt["jwt"]
    r = httpx.get(f"{BASE}/cameras/v1/footage/token",
                  headers={"x-api-key": os.environ["VERKADA_API_KEY"]},
                  params={"exclude_accessible_resources": "true"}, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"GET /cameras/v1/footage/token -> HTTP {r.status_code}: {r.text[:300]}")
    stream_jwt["jwt"] = r.json()["jwt"]
    stream_jwt["fetched_at"] = time.time()
    return stream_jwt["jwt"]


def clip_stream_url(org_id, camera_id, start, end):
    """Verkada's HLS playlist URL for footage from `start` to `end` (epoch seconds).
    The JWT in the URL is what authorizes it.

    No codec param, so we get Verkada's default (hevc). Don't ask for h264:
    Verkada can only convert recent footage to it. Once the camera files
    footage to its SD card (a few minutes after the scan), every h264 chunk
    404s ("Error fetching historical video m4s"). hevc plays in Chrome and
    Safari on a Mac; Firefox and some Windows PCs can't play it."""
    params = {
        "org_id": org_id,
        "camera_id": camera_id,
        "start_time": start,
        "end_time": end,
        "resolution": "high_res",
        "type": "stream",
        "jwt": get_stream_jwt(),
    }
    return f"{BASE}/stream/cameras/v1/footage/stream/stream.m3u8?{urlencode(params)}"


def clip_playlist(org_id, camera_id, start, end):
    """Verkada's playlist for the clip, fixed up so the page can play it.

    A playlist is a text file: a few header lines, then for each 4 s chunk of
    video some "#..." info lines followed by the chunk's link. Two fixes:

    - Verkada lists one chunk too many: one that starts at or after `end`.
      Fetching it fails (408, then 404), and the player gives up on the whole
      clip. So we drop every chunk that starts at or after `end`.
      A chunk's start time is read from its #EXT-X-PROGRAM-DATE-TIME line
      (standard HLS). The link's own params differ by footage age: recent
      footage has start_ts=, footage the camera has already filed away has ts=.
      Those are only a fallback.
    - The links are relative to Verkada's URL. The page now gets the playlist
      from our server, so they're made absolute (the video itself still comes
      straight from Verkada). That includes links inside "#..." lines: the
      setup chunk (#EXT-X-MAP) and the decryption key (#EXT-X-KEY).
    """
    url = clip_stream_url(org_id, camera_id, start, end)
    r = httpx.get(url, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"GET stream.m3u8 -> HTTP {r.status_code}: {r.text[:300]}")

    out = []
    chunk_info = []      # the "#..." lines of the chunk whose link comes next
    chunk_start = None   # that chunk's start time, epoch seconds
    for line in r.text.splitlines():
        if line.startswith("#") and 'URI="' in line:
            # A link inside an info line: the setup chunk every clip needs
            # (#EXT-X-MAP:URI="init.mp4?...") or, for footage the camera has
            # filed away, the decryption key (#EXT-X-KEY:METHOD=AES-128,URI="enc....key?...").
            before, rest = line.split('URI="', 1)
            link, after = rest.split('"', 1)
            out.append(f'{before}URI="{urljoin(url, link)}"{after}')
        elif line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            # e.g. #EXT-X-PROGRAM-DATE-TIME:2026-10-14T00:20:33+00:00
            stamp = line.split(":", 1)[1].replace("Z", "+00:00")
            chunk_start = datetime.fromisoformat(stamp).timestamp()
            chunk_info.append(line)
        elif line.startswith("#EXTINF"):
            chunk_info.append(line)
        elif line and not line.startswith("#"):
            # A chunk link. Keep it only if the chunk starts inside the clip.
            if chunk_start is None:
                params = parse_qs(urlsplit(line).query)
                chunk_start = int((params.get("start_ts") or params.get("ts") or ["0"])[0])
            if chunk_start < end:
                out += chunk_info + [urljoin(url, line)]
            else:
                print(f"[clip] dropped chunk starting {int(chunk_start)} (clip ends {end})")
            chunk_info = []
            chunk_start = None
        else:
            out.append(line)   # header lines and #EXT-X-ENDLIST
    return "\n".join(out) + "\n"

