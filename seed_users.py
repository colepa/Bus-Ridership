"""Add fake test students to Command so the real bus has a realistic roster.

Creates COUNT users and adds each to the access group that opens the bus's door,
so "Refresh roster" picks them up. Every user gets an external_id starting with
"busdemo-", which is how --delete finds them again. No cards are assigned: they
can't tap the real reader, only fake taps (fake_tap.py / simulate.py).

Usage:
    uv run python seed_users.py                 # add 49 users (+ your existing one = 50)
    uv run python seed_users.py --delete        # remove every busdemo- user
    uv run python seed_users.py --group <group_id>   # if the door has several groups

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

COUNT = 49
PREFIX = "busdemo-"

FIRST = ["Ava", "Liam", "Mia", "Noah", "Zoe", "Eli", "Ruby", "Owen", "Ivy", "Leo",
         "Nora", "Finn", "Maya", "Jude", "Lila", "Cole", "Hazel", "Miles", "Iris", "Theo",
         "Clara", "Jonah", "Elsie", "Felix", "June", "Arlo", "Wren", "Silas", "Opal", "Hugo"]
LAST = ["Alder", "Birch", "Cedar", "Dunmore", "Ellery", "Fairway", "Glenn", "Hollis",
        "Ingram", "Juniper", "Kestrel", "Linden", "Marsh", "Northcott", "Oakley", "Pell",
        "Quill", "Rowan", "Sable", "Thorne", "Underhill", "Vale", "Whitlock", "Yarrow"]


def fake_names(count):
    """Same names every run (fixed seed), so re-running doesn't make new people."""
    rng = random.Random(7)
    pairs = [(f, l) for f in FIRST for l in LAST]
    return rng.sample(pairs, count)


def call(method, token, path, params=None, body=None):
    r = httpx.request(method, f"{BASE}{path}", headers={"x-verkada-auth": token},
                      params=params, json=body, timeout=20)
    time.sleep(0.2)   # stay well under Verkada's rate limit
    return r


def find_group(token):
    """The one access group that opens the one door. Exits with a hint otherwise."""
    doors = api_get(token, "/access/v1/doors").get("doors", [])
    if len(doors) != 1:
        sys.exit(f"Found {len(doors)} doors; this script assumes one. Pass --group <group_id>.")
    door = doors[0]
    door_id = door.get("door_id") or door.get("doorId") or door.get("id")

    groups = set()
    for level in api_get(token, "/access/v1/door/access_level").get("access_levels", []):
        if door_id in level.get("doors", []):
            groups.update(level.get("access_groups", []))
    if len(groups) != 1:
        sys.exit(f"Door '{door.get('name')}' has {len(groups)} access groups: {sorted(groups)}\n"
                 "Pass the one you want with --group <group_id>.")
    print(f"Door '{door.get('name')}' -> group {next(iter(groups))}")
    return groups.pop()


def add_users(token, group_id):
    for i, (first, last) in enumerate(fake_names(COUNT), start=1):
        external_id = f"{PREFIX}{i:02d}"
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


def delete_users(token):
    for i in range(1, COUNT + 1):
        external_id = f"{PREFIX}{i:02d}"
        r = call("DELETE", token, "/core/v1/user", params={"external_id": external_id})
        print(f"  {external_id}: HTTP {r.status_code}")
    print("Done. Press 'Refresh roster' on the page.")


def main():
    args = sys.argv[1:]
    token = get_token()
    if "--delete" in args:
        delete_users(token)
        return
    if "--group" in args:
        group_id = args[args.index("--group") + 1]
    else:
        group_id = find_group(token)
    add_users(token, group_id)


if __name__ == "__main__":
    main()
