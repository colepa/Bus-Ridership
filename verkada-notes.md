# Verkada webhook notes

Reference for whoever is working on the webhook. Learned the hard way — don't
re-derive. Sources: [Access Events Webhooks](https://apidocs.verkada.com/reference/access-events-webhooks),
[Securing Webhooks](https://apidocs.verkada.com/reference/securing-webhooks).

## Payload

Envelope: `{org_id, webhook_type: "notification", created_at, webhook_id, data}`.
`webhook_type` is always the literal `"notification"` — the real discriminator is
`data.notification_type`. For boarding we want `door_keycard_entered_accepted`
(and `door_mobile_nfc_scan_accepted` if phones are in play). Everything else —
door opened, held open, tamper, fire alarm — gets a 200 and is ignored.

An accepted tap is followed by `door_unlocked` and then `door_locked`, both
carrying the same `user_id` but their own `event_id`. Ignore them, or every
boarding counts three times. (Seen in test-org captures, 2026-10-12.)

`door_keycard_entered_rejected` comes in two flavors: card not assigned to anyone
(`user_info` empty) and known user without access (`user_id` present). On a bus
the second one may still mean the student boarded — the reader may not control
the door. Undecided how to show it; not in the first version.

Tap time is `data.created`, epoch **seconds**. Each event has a `data.event_id`
(UUID) — the likely dedupe key against `GET /v2/events` during backfill, *not yet
confirmed* to match the API's `event_id` for the same tap.

## Identity

**Use `data.user_info.user_id`, not the card number.** `data.input_value` changes
format between credential types — `"facility|card"` (e.g. `"102|53029"`) on a
keycard, reportedly a 40-bit binary string on NFC and a UUID on face. Keying off
it works in testing and breaks confusingly later.

(Earlier notes said rejected keycard taps carry the binary string. Test-org
captures on 2026-10-12 show rejected keycards use `"facility|card"` too.)

`user_info` also carries name, email and phone. Irrelevant for a test roster, but
don't log it out of habit.

## Signature

Header: `Verkada-Signature: <timestamp>|<signature>`, split on `|`.

Signed payload is `raw_body + "|" + timestamp` — **body first**, which is the
reverse of the Stripe convention it resembles. HMAC-SHA256, hex digest. Verify
against the raw request bytes; parsing the JSON first changes the bytes and the
digest won't match.

Verkada's own sample rejects anything older than 60 seconds and returns 403.

```python
import hmac, hashlib
ts, sig = request.headers["Verkada-Signature"].split("|")
expected = hmac.new(secret, raw_body + b"|" + ts.encode(), hashlib.sha256).hexdigest()
if not hmac.compare_digest(sig, expected):
    ...
```

## Direction

`data.direction` is `"Inbound"` / `"Outbound"` only if the door is configured as
an In/Out Door in Command. Otherwise it's null.

**Decision (2026-10-12): no In/Out doors. One reader, taps toggle.** Two readers
cut software complexity but depend on students tapping the right one — one
on-tap at the off reader corrupts the manifest. One reader can't be tapped wrong.

So `direction` is always null and on/off comes from the tap sequence:

- Store accepted taps per student for the current route, keyed by `event_id`
  (so webhook + backfill copies of the same tap collapse to one).
- Compute "on the bus" from scratch: sort by time, drop taps by the same student
  within the debounce window, count. Odd = on, even = off.
- Never keep a stored on/off flag. Backfilled taps arrive late and out of order;
  a flipped flag goes wrong, a recomputed count doesn't.
- End of route: odd count = never tapped off.

Routes are started and ended by hand with buttons on the page (MVP).

## Not in the payload

No GPS. No video clip reference (`door_info.camera_info` is null in every
documented example). Both need separate Command API calls if you want them.

## Endpoint requirements

Public HTTPS with a CA-signed cert, responds in under 2000 ms, returns JSON.
200 success, 4xx invalid, 500 means "retry later". Use `cloudflared` or `ngrok`
for local testing.

Configure the webhook in Command → Organization Settings → Verkada API.
