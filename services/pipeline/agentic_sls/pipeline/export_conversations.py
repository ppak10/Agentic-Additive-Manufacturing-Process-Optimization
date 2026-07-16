"""Flat-file export of agent conversations (agent_conversations,
agent_messages, agent_sessions) for the Agentic-SLS-Conversations HF dataset.

One JSONL row per conversation:
  {id, created_at, harness, model, role, preset, build_id, cli_session_id,
   context, transcript_dir,
   turns:    [{turn, started_at, ended_at, tool_calls, tokens_in,
               tokens_out, exit_code}],
   messages: [{turn, seq, ts, kind, content, tool_name, tool_input,
               is_error}]}

Message kinds: context | user | assistant | tool_call | tool_result | meta.

Safety: refuses to write if any message payload contains a credential
(the DATABASE_URL password or a postgres:// URL) — conversations get
published; the recorder DB does not.

Writes directly into the Conversations dataset's data/ (the published
file; data/exports retired 2026-07-16).

Usage:
  uv run sls-export-conversations
  uv run sls-export-conversations --out /tmp/exports
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv


def _json_default(obj):
    if isinstance(obj, datetime):
        if obj.tzinfo is None:
            obj = obj.replace(tzinfo=timezone.utc)
        return obj.astimezone(timezone.utc).isoformat()
    raise TypeError(f"unhandled type for JSON: {type(obj)}")


def _rows(cur) -> list[dict]:
    cols = [d.name for d in cur.description]
    return [dict(zip(cols, r)) for r in cur]


def secret_patterns(dsn: str) -> list[re.Pattern]:
    pats = [re.compile(r"postgres(?:ql)?://\S+", re.I)]
    m = re.match(r".*?://[^:]+:([^@]+)@", dsn)
    if m and len(m.group(1)) >= 4:
        pats.append(re.compile(re.escape(m.group(1))))
    return pats


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Export agent conversations to flat JSONL.")
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parent.parent.parent.parent.parent
                    / "datasets" / "Agentic-SLS-Conversations" / "data")
    args = ap.parse_args()

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL is not set (check .env)", file=sys.stderr)
        return 1
    secrets = secret_patterns(dsn)

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM agent_conversations ORDER BY id")
            convs = _rows(cur)
            cur.execute(
                "SELECT conversation_id, turns AS turn, started_at, ended_at,"
                " tool_calls, tokens_in, tokens_out, exit_code"
                " FROM agent_sessions WHERE conversation_id IS NOT NULL"
                " ORDER BY conversation_id, turns")
            turns = _rows(cur)
            cur.execute(
                "SELECT conversation_id, turn, seq, ts, kind, content,"
                " tool_name, tool_input, is_error"
                " FROM agent_messages ORDER BY conversation_id, turn, seq")
            messages = _rows(cur)

    by_conv_turns: dict[int, list[dict]] = {}
    for t in turns:
        by_conv_turns.setdefault(t.pop("conversation_id"), []).append(t)
    by_conv_msgs: dict[int, list[dict]] = {}
    for m in messages:
        by_conv_msgs.setdefault(m.pop("conversation_id"), []).append(m)

    out_path = args.out / "conversations.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    leaks = 0
    with out_path.open("w") as f:
        for c in convs:
            row = {
                **c,
                "turns": by_conv_turns.get(c["id"], []),
                "messages": by_conv_msgs.get(c["id"], []),
            }
            line = json.dumps(row, default=_json_default)
            if any(p.search(line) for p in secrets):
                leaks += 1
                print(f"  LEAK: conversation {c['id']} contains a credential"
                      " — excluded", file=sys.stderr)
                continue
            f.write(line + "\n")
            n += 1

    print(f"conversations.jsonl: {n} conversations"
          + (f" ({leaks} EXCLUDED for credential leaks)" if leaks else ""))
    return 1 if leaks else 0


if __name__ == "__main__":
    raise SystemExit(main())
