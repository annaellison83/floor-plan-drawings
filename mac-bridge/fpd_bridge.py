#!/usr/bin/env python3
"""Read-only first-phase bridge for the macOS Messages database.

The bridge is deliberately ingest-only. It can observe new inbound Messages
rows and, only when explicitly enabled with a URL and token, forward a
normalized envelope to Master. It has no outbound-send capability.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


APPLE_EPOCH = 978307200
SUPPORTED_SERVICES = {"iMessage", "SMS", "RCS"}
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def clean(value):
    return "" if value is None else str(value).strip()


def normalize_phone(value):
    raw = clean(value)
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+") and 8 <= len(digits) <= 15:
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return ""


def normalize_target(value):
    return normalize_phone(value) or clean(value).lower()


def apple_date(value):
    try:
        seconds = float(value) / 1_000_000_000 + APPLE_EPOCH
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def truthy(value, default=False):
    if value is None:
        return default
    return clean(value).lower() in {"1", "true", "yes", "on"}


def default_state_path():
    return Path(os.environ.get(
        "FPD_BRIDGE_STATE_PATH",
        "~/Library/Application Support/FloorPlanDrawings/mac-bridge/state.json",
    )).expanduser()


def load_state(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"lastRowid": 0, "updatedAt": ""}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".state-", delete=False) as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def open_database(path):
    uri = f"file:{urllib.parse.quote(str(path), safe='/')}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def max_rowid(connection):
    return int(connection.execute("SELECT COALESCE(MAX(rowid), 0) FROM message").fetchone()[0])


def read_rows(connection, after_rowid, limit=100):
    query = """
        SELECT
          m.rowid,
          m.guid,
          m.service,
          m.is_from_me,
          h.id,
          m.text,
          m.date,
          m.destination_caller_id,
          (
            SELECT count(*)
            FROM message_attachment_join maj
            WHERE maj.message_id = m.rowid
          ),
          (
            SELECT c.chat_identifier
            FROM chat_message_join cmj
            JOIN chat c ON c.rowid = cmj.chat_id
            WHERE cmj.message_id = m.rowid
            ORDER BY c.rowid
            LIMIT 1
          )
        FROM message m
        LEFT JOIN handle h ON h.rowid = m.handle_id
        WHERE m.rowid > ?
        ORDER BY m.rowid
        LIMIT ?
    """
    return connection.execute(query, (after_rowid, limit)).fetchall()


def envelope_from_row(row, business_number, strict_destination=True):
    rowid, guid, service, is_from_me, handle_id, body, apple_timestamp, destination, attachment_count, conversation_id = row
    if service not in SUPPORTED_SERVICES:
        return None, "unsupported-service"
    if int(is_from_me or 0):
        return None, "outbound"
    if strict_destination and normalize_target(destination) != business_number:
        return None, "destination-not-business-line"

    sender = clean(handle_id)
    sender_phone = normalize_phone(sender)
    sender_value = {"phone": sender_phone} if sender_phone else ({"email": sender.lower()} if EMAIL_RE.match(sender) else {})
    if not sender_value:
        return None, "unknown-sender"

    channel = "imessage" if service == "iMessage" else ("mms" if attachment_count else "sms")
    body_summary = clean(body) or ("[Attachment-only message]" if attachment_count else "")
    envelope = {
        "channel": channel,
        "provider": "mac-messages",
        "externalMessageId": clean(guid) or f"mac-messages-row-{rowid}",
        "conversationId": clean(conversation_id),
        "sender": sender_value,
        "recipients": [{"phone": business_number}],
        "body": body_summary,
        "receivedAt": apple_date(apple_timestamp),
        "metadata": {
            "macMessageRowid": rowid,
            "macService": service,
            "destinationCallerIdPresent": bool(clean(destination)),
            "attachmentCount": int(attachment_count or 0),
        },
    }
    if not envelope["body"]:
        return None, "empty-body"
    return envelope, "ready"


def post_json(url, token, payload):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Communication-Ingest-Token": token,
            "User-Agent": "fpd-mac-bridge/0.1",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.status, response.read().decode("utf-8", errors="replace")


def heartbeat_payload(bridge_id, queued_inbound=0):
    now = datetime.now(timezone.utc).isoformat()
    return {
        "bridgeId": bridge_id,
        "channel": "imessage",
        "version": "0.1-read-only",
        "queuedInbound": queued_inbound,
        "lastSuccessfulReceiveAt": now,
    }


def heartbeat_url(ingest_url, explicit_url):
    if clean(explicit_url):
        return clean(explicit_url)
    suffix = "/api/communications/inbound"
    if clean(ingest_url).endswith(suffix):
        return clean(ingest_url)[:-len(suffix)] + "/api/phone/heartbeat"
    return ""


def run_once(args):
    db_path = Path(args.db).expanduser()
    state_path = Path(args.state).expanduser()
    business_number = normalize_target(args.business_number)
    if not business_number:
        raise SystemExit("A valid BUSINESS_PHONE_NUMBER is required")

    with open_database(db_path) as connection:
        current_rowid = max_rowid(connection)
        state = load_state(state_path)
        if args.initialize:
            save_state(state_path, {"lastRowid": current_rowid, "updatedAt": datetime.now(timezone.utc).isoformat()})
            print(json.dumps({"ok": True, "initializedAtRowid": current_rowid, "state": str(state_path)}))
            return

        after_rowid = int(state.get("lastRowid") or 0)
        rows = read_rows(connection, after_rowid, args.limit)
        ready = []
        skipped = {}
        for row in rows:
            envelope, reason = envelope_from_row(row, business_number, args.strict_destination)
            if envelope:
                ready.append(envelope)
            else:
                skipped[reason] = skipped.get(reason, 0) + 1

    url = clean(args.ingest_url)
    token = clean(args.ingest_token)
    sent = 0
    errors = []
    heartbeat_sent = False
    if args.apply and ready:
        if not url or not token:
            raise SystemExit("--apply requires FPD_INGEST_URL and FPD_INGEST_TOKEN")
        for envelope in ready:
            try:
                status, response = post_json(url, token, envelope)
                if status >= 300:
                    raise RuntimeError(f"HTTP {status}: {response[:200]}")
                sent += 1
            except (OSError, urllib.error.URLError, RuntimeError) as error:
                errors.append(str(error))
                break

    if args.apply and not errors:
        heartbeat_endpoint = heartbeat_url(url, args.heartbeat_url)
        if heartbeat_endpoint and token:
            try:
                status, response = post_json(
                    heartbeat_endpoint,
                    token,
                    heartbeat_payload(args.bridge_id, max(0, len(rows) - len(ready))),
                )
                if status >= 300:
                    raise RuntimeError(f"HTTP {status}: {response[:200]}")
                heartbeat_sent = True
            except (OSError, urllib.error.URLError, RuntimeError) as error:
                errors.append(f"heartbeat: {error}")

    checkpoint = after_rowid
    if args.apply and not errors:
        checkpoint = max((row[0] for row in rows), default=after_rowid)
        save_state(state_path, {"lastRowid": checkpoint, "updatedAt": datetime.now(timezone.utc).isoformat()})

    print(json.dumps({
        "ok": not errors,
        "db": str(db_path),
        "afterRowid": after_rowid,
        "currentRowid": current_rowid,
        "rowsRead": len(rows),
        "ready": len(ready),
        "sent": sent,
        "heartbeatSent": heartbeat_sent,
        "skipped": skipped,
        "checkpoint": checkpoint,
        "dryRun": not args.apply,
        "errors": errors,
        "preview": [
            {
                "channel": item["channel"],
                "externalMessageId": item["externalMessageId"],
                "sender": item["sender"],
                "receivedAt": item["receivedAt"],
                "bodyLength": len(item["body"]),
            }
            for item in ready[:args.preview]
        ],
    }, indent=2, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=os.environ.get("FPD_MESSAGES_DB", "~/Library/Messages/chat.db"))
    parser.add_argument("--state", default=str(default_state_path()))
    parser.add_argument("--business-number", default=os.environ.get("BUSINESS_PHONE_NUMBER", "+12134357223"))
    parser.add_argument("--ingest-url", default=os.environ.get("FPD_INGEST_URL", ""))
    parser.add_argument("--ingest-token", default=os.environ.get("FPD_INGEST_TOKEN", ""))
    parser.add_argument("--heartbeat-url", default=os.environ.get("FPD_HEARTBEAT_URL", ""))
    parser.add_argument("--bridge-id", default=os.environ.get("FPD_BRIDGE_ID", "fpd-mac-mini"))
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--preview", type=int, default=5)
    parser.add_argument("--initialize", action="store_true", help="Set the checkpoint to the current DB rowid without ingesting history")
    parser.add_argument("--apply", action="store_true", help="Forward messages and commit the checkpoint; off by default")
    parser.add_argument("--watch", action="store_true", help="Poll continuously; still dry-run unless --apply is supplied")
    parser.add_argument("--interval", type=float, default=float(os.environ.get("FPD_BRIDGE_INTERVAL_SECONDS", "10")))
    parser.add_argument("--strict-destination", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    if args.watch:
        while True:
            run_once(args)
            time.sleep(max(1, args.interval))
    else:
        run_once(args)


if __name__ == "__main__":
    main()
