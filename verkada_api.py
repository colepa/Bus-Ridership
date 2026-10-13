"""Calls to Verkada's Command API. Only used when you press "Refresh roster".

fetch_buses() returns, for every door in the org:
    {"<door_id>": {"name": "Bus 12", "roster": {"<user_id>": "Student Name", ...}}}

Roster = everyone who has access to that door:
    access levels (door -> groups)  ->  groups (group -> users)  ->  users (user -> name)
Schedules on access levels are ignored: in a level means on the roster.

Needs VERKADA_API_KEY with read access to Access Control (doors, access levels,
groups, users).
"""

import os

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
