#!/usr/bin/env python3
"""Read only quota events from a supplied Codex session JSONL; never read auth.

Usage: python3 scripts/check-codex-quota.py /path/to/rollout.jsonl
This reports a timestamped snapshot, not a live account query or wake scheduler.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    args = parser.parse_args()
    latest = None
    with args.session.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                continue  # Session writer may still be appending the final line.
            payload = event.get("payload")
            if (event.get("type") != "event_msg" or not isinstance(payload, dict)
                    or payload.get("type") != "token_count"):
                continue
            limits = payload.get("rate_limits")
            if isinstance(limits, dict):
                latest = {"observed_at": event.get("timestamp"), "windows": {}}
                for name in ("primary", "secondary"):
                    window = limits.get(name)
                    if not isinstance(window, dict):
                        continue
                    used = window.get("used_percent")
                    reset = window.get("resets_at")
                    latest["windows"][name] = {
                        "used_percent": used,
                        "remaining_percent": max(0, 100 - used) if isinstance(used, (int, float)) else None,
                        "window_minutes": window.get("window_minutes"),
                        "resets_at_utc": datetime.fromtimestamp(reset, timezone.utc).isoformat()
                        if isinstance(reset, (int, float)) else None,
                    }
    print(json.dumps({"status": "snapshot" if latest else "unavailable", "quota": latest,
                      "remaining_tokens": None, "automatic_wake_configured": False}, indent=2))


if __name__ == "__main__":
    main()
