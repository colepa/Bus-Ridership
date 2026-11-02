"""Add fake test students to Command so the real buses have realistic rosters.

Creates the bus's users and adds each to the access group that opens the bus's
door, so "Refresh roster" picks them up. Each bus has its own external_id
prefix (see BUSES), which is how --delete finds them again. No cards are
assigned: they can't tap the real reader, only fake taps (fake_tap.py /
simulate.py).

Usage:
    uv run python seed_users.py                  # bus 1: add 49 users (+ your existing one = 50)
    uv run python seed_users.py --bus 2          # bus 2: add 45 users
    uv run python seed_users.py --bus 2 --delete # remove bus 2's users
    uv run python seed_users.py --bus 2 --group <group_id>   # if the door has several groups

Needs VERKADA_API_KEY with read/write on Core Command and Door Access Management.
Safe to run twice: users that already exist are just re-added to the group.
"""

import random
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

from verkada_api import BASE, api_get, get_token  # after load_dotenv, for VERKADA_REGION

# The real buses (doors in Command). Bus 1's settings are what the script always
# used, so re-running it for bus 1 finds the same users.
BUSES = {
    "1": {"door_id": "bb2c0f6d-5312-4f60-a9de-fabf42eba821", "prefix": "busdemo-", "count": 49},
    "2": {"door_id": "926c02da-02c7-473e-8b9d-99ac3d66fcc3", "prefix": "busdemo2-", "count": 45},
}

FIRST = ["Ava", "Liam", "Mia", "Noah", "Zoe", "Eli", "Ruby", "Owen", "Ivy", "Leo",
         "Nora", "Finn", "Maya", "Jude", "Lila", "Cole", "Hazel", "Miles", "Iris", "Theo",
         "Clara", "Jonah", "Elsie", "Felix", "June", "Arlo", "Wren", "Silas", "Opal", "Hugo"]
LAST = ["Alder", "Birch", "Cedar", "Dunmore", "Ellery", "Fairway", "Glenn", "Hollis",
        "Ingram", "Juniper", "Kestrel", "Linden", "Marsh", "Northcott", "Oakley", "Pell",
        "Quill", "Rowan", "Sable", "Thorne", "Underhill", "Vale", "Whitlock", "Yarrow"]


def fake_names(bus):
    """Same names every run (fixed seed), so re-running doesn't make new people.
    Goes through the buses in order and removes each bus's names before picking
    the next bus's, so no two buses share a student name."""
    pairs = [(f, l) for f in FIRST for l in LAST]
    for key, info in BUSES.items():
        names = random.Random(7).sample(pairs, info["count"])
        if key == bus:
            return names
        pairs = [p for p in pairs if p not in names]


def call(method, token, path, params=None, body=None):
    r = httpx.request(method, f"{BASE}{path}", headers={"x-verkada-auth": token},
                      params=params, json=body, timeout=20)
    time.sleep(0.2)   # stay well under Verkada's rate limit
    return r


def find_group(token, door_id):
    """The one access group that opens this door. Exits with a hint otherwise."""
    levels = api_get(token, "/access/v1/door/access_level").get("access_levels", [])
    groups = set()
    for level in levels:
        if door_id in level.get("doors", []):
            groups.update(level.get("access_groups", []))
    if len(groups) != 1:
        sys.exit(f"Door {door_id} has {len(groups)} access groups: {sorted(groups)}\n"
                 "In Command, give this door its own access group + access level, "
                 "or pass the one you want with --group <group_id>.")
    group_id = groups.pop()

    # A group that also opens another bus's door would put these students on both rosters.
    other_doors = set()
    for level in levels:
        if group_id in level.get("access_groups", []):
            other_doors.update(d for d in level.get("doors", []) if d != door_id)
    if other_doors:
        sys.exit(f"Group {group_id} also opens {sorted(other_doors)}, so these students "
                 "would show up on that bus too. Give this door its own group in Command.")
    print(f"Door {door_id} -> group {group_id}")
    return group_id


def add_users(token, bus, group_id):
    prefix = BUSES[bus]["prefix"]
    for i, (first, last) in enumerate(fake_names(bus), start=1):
        external_id = f"{prefix}{i:02d}"
        r = call("POST", token, "/core/v1/user",
                 body={"external_id": external_id, "first_name": first, "last_name": last})
        if r.status_code == 409:
            status = "exists"
        elif r.status_code == 200:
            status = "created"
        else:
            sys.exit(f"Create {external_id} failed: HTTP {r.status_code} {r.text[:300]}")

        r = call("PUT", token, "/access/v1/access_groups/group/user",
                 params={"group_id": group_id}, body={"external_id": external_id})
        if r.status_code != 200:
            sys.exit(f"Add {external_id} to group failed: HTTP {r.status_code} {r.text[:300]}")
        print(f"  {external_id}  {first} {last}  ({status}, in group)")
    print(f"Done. Press 'Refresh roster' on the page.")


def delete_users(token, bus):
    prefix = BUSES[bus]["prefix"]
    for i in range(1, BUSES[bus]["count"] + 1):
        external_id = f"{prefix}{i:02d}"
        r = call("DELETE", token, "/core/v1/user", params={"external_id": external_id})
        print(f"  {external_id}: HTTP {r.status_code}")
    print("Done. Press 'Refresh roster' on the page.")


def main():
    args = sys.argv[1:]
    bus = args[args.index("--bus") + 1] if "--bus" in args else "1"
    if bus not in BUSES:
        sys.exit(f"Unknown bus {bus}. Known: {', '.join(BUSES)}")
    token = get_token()
    if "--delete" in args:
        delete_users(token, bus)
        return
    if "--group" in args:
        group_id = args[args.index("--group") + 1]
    else:
        group_id = find_group(token, BUSES[bus]["door_id"])
    add_users(token, bus, group_id)


if __name__ == "__main__":
    main()
