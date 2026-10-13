"""Webhook probe: receive anything Verkada sends, save it, print a summary.

Never rejects a request — the point is to see what arrives. It reports
whether the signature checks out, but returns 200 either way.

Run (from the project root):
    uv run uvicorn webhook_probe:app --app-dir tools/verkada-probe --port 8000
Then expose it:
    cloudflared tunnel --url http://localhost:8000
and paste the https URL + /webhook into Command.
"""

import hashlib
import hmac
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request

# Project-root .env, found from this file's location so the working directory doesn't matter.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
SECRET = os.getenv("VERKADA_WEBHOOK_SECRET", "")
CAPTURES = Path(__file__).parent / "captures"
CAPTURES.mkdir(exist_ok=True)

app = FastAPI()


def check_signature(raw_body, header):
    """Return a short string describing the signature check result."""
    if not SECRET:
        return "not checked (VERKADA_WEBHOOK_SECRET not set)"
    if not header or "|" not in header:
        return f"missing or malformed header: {header!r}"
    ts, sig = header.split("|", 1)
    # Body first, then timestamp — see verkada-notes.md.
    expected = hmac.new(SECRET.encode(), raw_body + b"|" + ts.encode(), hashlib.sha256).hexdigest()
    ok = hmac.compare_digest(sig, expected)
    age = int(time.time()) - int(ts) if ts.isdigit() else "?"
    return f"{'VALID' if ok else 'INVALID'} (age {age}s)"


@app.post("/webhook")
async def webhook(request: Request):
    raw = await request.body()
    sig_result = check_signature(raw, request.headers.get("verkada-signature"))

    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        body = None

    # Save everything, raw. captures/ is gitignored (real test-org names live here).
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = CAPTURES / f"webhook-{stamp}-{time.time_ns() % 1_000_000}.json"
    path.write_text(json.dumps({
        "received_at": time.time(),
        "signature_check": sig_result,
        "headers": dict(request.headers),
        "body": body,
        "raw_body": None if body is not None else raw.decode(errors="replace"),
    }, indent=2))

    # One-line summary in the terminal. No names/emails — just ids.
    data = (body or {}).get("data") or {}
    user = data.get("user_info") or {}
    print(
        f"[webhook] {data.get('notification_type')!s:40} "
        f"user_id={user.get('user_id')} direction={data.get('direction')} "
        f"created={data.get('created')} sig={sig_result} -> {path.name}"
    )
    return {"ok": True}


@app.get("/")
def health():
    return {"ok": True, "captures": len(list(CAPTURES.glob("webhook-*.json")))}
