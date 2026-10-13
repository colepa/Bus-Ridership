"""Play out a route with fake taps, so the page looks like a real morning.

With the app running on port 8000:

    uv run python simulate.py board                       # every bus
    uv run python simulate.py board fake-bus-2 fake-bus-3 # just these
    uv run python simulate.py dropoff                     # every bus
    uv run python simulate.py board --seconds 20          # faster (default 90)
    uv run python simulate.py history                     # 10 school days of past routes
    uv run python simulate.py history --days 20

board:   starts the route (the previous one goes to history), then over
         --seconds taps on ~90% of each roster in random order. The rest stay
         "Not boarded yet". Each bus also gets one rejected tap from a card
         assigned to nobody.
dropoff: taps off everyone on the bus except one student. Press "End route"
         on the page afterwards to see the "Never tapped off" warning.
history: makes up an AM and PM route per bus for each past school day, for
         student lookup. Mostly normal rides, plus some no-shows, wrong-bus
         scans, unknown cards and a rare "never tapped off". Running it again
         replaces the made-up history; real routes are kept.

Works on the real bus too (use its door_id from the page URL), once "Refresh
roster" has filled its roster. All taps are fake; nothing goes to Command.
"""

import random
import sys
import time
import uuid
from datetime import date, datetime, timedelta

import httpx

from fake_tap import send_tap

APP = "http://localhost:8000"
REJECTED = "door_keycard_entered_rejected"


def pop_flag(args, flag, default):
    if flag not in args:
        return default
    i = args.index(flag)
    value = args[i + 1]
    del args[i:i + 2]
    return value


def plan_boarding(door_id, seconds):
    """Start the route and return [(delay, door_id, user_id, name, kind), ...]."""
    httpx.post(f"{APP}/bus/{door_id}/route/start").raise_for_status()
    roster = httpx.get(f"{APP}/bus/{door_id}").json()["not_boarded"]
    riders = random.sample(roster, round(len(roster) * 0.9))
    plan = [(random.uniform(0, seconds), door_id, s["user_id"], s["name"], None) for s in riders]
    plan.append((random.uniform(0, seconds), door_id, "unknown", "", REJECTED))
    print(f"{door_id}: route started, {len(riders)} of {len(roster)} will board")
    return plan


def plan_dropoff(door_id, seconds):
    on_bus = httpx.get(f"{APP}/bus/{door_id}").json()["on_bus"]
    leaving = on_bus[1:]   # the first one "forgets" to tap off
    if on_bus:
        print(f"{door_id}: {len(leaving)} tap off, {on_bus[0]['name']} stays on")
    return [(random.uniform(0, seconds), door_id, s["user_id"], s["name"], None) for s in leaving]


def at(day, hour, minute):
    """Epoch seconds for a local time on a given day."""
    return int(datetime(day.year, day.month, day.day, hour, minute).timestamp())


def past_school_days(count):
    days, d = [], date.today()
    while len(days) < count:
        d -= timedelta(days=1)
        if d.weekday() < 5:          # Mon-Fri
            days.append(d)
    return days


def fake_route(door_id, bus_name, roster, day, am, skip, wrong_bus_riders):
    """One made-up past route, same shape as state["past_routes"] entries.

    AM: students board at stops 7:05-7:40 and all get off at school ~8:00.
    PM: everyone boards at school 3:00-3:08 and gets off at stops 3:20-4:10.
    skip: students riding a different bus this route (they don't show here).
    wrong_bus_riders: students from other buses who scan here and get rejected.
    """
    start = at(day, 7, 0) if am else at(day, 15, 0)
    taps, alerts = {}, {}
    for user_id, name in roster.items():
        if user_id in skip or random.random() < 0.06:     # ~6% no-shows
            continue
        if am:
            on = start + random.randint(5 * 60, 40 * 60)
            off = at(day, 7, 58) + random.randint(0, 4 * 60)
        else:
            on = start + random.randint(0, 8 * 60)
            off = start + random.randint(20 * 60, 70 * 60)
        taps[str(uuid.uuid4())] = {"user_id": user_id, "name": name, "time": on}
        if random.random() > 0.002:                         # very rarely, never taps off
            taps[str(uuid.uuid4())] = {"user_id": user_id, "name": name, "time": off}

    for user_id, name in wrong_bus_riders:
        alerts[str(uuid.uuid4())] = {"user_id": user_id, "name": name, "card": "102|5" + user_id[-4:],
                                     "time": start + random.randint(5 * 60, 30 * 60)}
    if random.random() < 0.1:                               # a card assigned to nobody
        alerts[str(uuid.uuid4())] = {"user_id": None, "name": None,
                                     "card": f"102|{random.randint(10000, 99999)}",
                                     "time": start + random.randint(5 * 60, 30 * 60)}

    last = max([t["time"] for t in taps.values()] + [start])
    return {"door_id": door_id, "bus_name": bus_name, "started_at": start,
            "ended_at": last + 5 * 60, "roster": roster, "taps": taps, "alerts": alerts}


def make_history(door_ids, days):
    rosters, names = {}, {}
    for door_id in door_ids:
        bus = httpx.get(f"{APP}/bus/{door_id}").json()
        if bus["roster"]:
            rosters[door_id] = {s["user_id"]: s["name"] for s in bus["roster"]}
            names[door_id] = bus["name"]

    routes = []
    for day in past_school_days(days):
        for am in (True, False):
            # About half the routes, one student scans on the wrong bus.
            wrong = {}   # door_id -> [(user_id, name)]
            skip = set()
            if len(rosters) > 1 and random.random() < 0.5:
                home, other = random.sample(list(rosters), 2)
                user_id = random.choice(list(rosters[home]))
                wrong[other] = [(user_id, rosters[home][user_id])]
                skip.add(user_id)
            for door_id, roster in rosters.items():
                routes.append(fake_route(door_id, names[door_id], roster, day, am,
                                         skip, wrong.get(door_id, [])))

    r = httpx.post(f"{APP}/demo/history", json=routes)
    r.raise_for_status()
    print(f"Made {len(routes)} past routes over {days} school days for: {', '.join(names.values())}")


def main():
    args = sys.argv[1:]
    seconds = float(pop_flag(args, "--seconds", "90"))
    days = int(pop_flag(args, "--days", "10"))
    if not args or args[0] not in ("board", "dropoff", "history"):
        print(__doc__)
        sys.exit(1)
    mode, door_ids = args[0], args[1:]
    if not door_ids:
        door_ids = [b["door_id"] for b in httpx.get(f"{APP}/buses").json()]

    if mode == "history":
        make_history(door_ids, days)
        return

    plan = []
    for door_id in door_ids:
        if mode == "board":
            plan += plan_boarding(door_id, seconds)
        else:
            plan += plan_dropoff(door_id, seconds)

    # Send every tap at its planned moment, all buses interleaved.
    start = time.time()
    for delay, door_id, user_id, name, kind in sorted(plan):
        time.sleep(max(0, start + delay - time.time()))
        r = send_tap(user_id, name, door_id, kind or "door_keycard_entered_accepted")
        label = "REJECTED card" if kind == REJECTED else name
        print(f"  +{delay:5.1f}s  {door_id}  {label}  -> {r.status_code}")
    print("Done.")


if __name__ == "__main__":
    main()
