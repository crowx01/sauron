"""Durable store for `sauron chat` sessions — the self-contained REPL's own
rolling conversation context (the ``history`` list), persisted to SQLite so a
session survives a restart and ``/resume`` can bring it back.

This is deliberately separate from utils.conversation_memory (the MCP tool
continuation-thread store): the self-contained REPL does not route chat through
the MCP layer, so it owns and persists its context here. Embedded, stdlib-only
(sqlite3), WAL mode; one file at ~/.pal/sessions.db (shared with SqliteStorage
but a distinct table). All failures degrade to a no-op so a storage problem can
never break the chat loop.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _db_path() -> str:
    return os.getenv("PAL_SESSION_DB") or os.getenv("PAL_STORAGE_DB") or str(Path.home() / ".pal" / "sessions.db")


def _connect() -> sqlite3.Connection | None:
    global _conn
    if _conn is not None:
        return _conn
    try:
        path = _db_path()
        if path != ":memory:":
            Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)
            path = str(Path(path).expanduser())
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_sessions ("
            "id TEXT PRIMARY KEY, cwd TEXT, model TEXT, turns INTEGER, "
            "updated_at REAL, history TEXT NOT NULL)"
        )
        conn.commit()
        _conn = conn
        return _conn
    except Exception as exc:  # noqa: BLE001 - storage is best-effort
        log.debug("session_store connect failed: %s", exc)
        return None


def reset() -> None:
    """Test helper: drop the cached connection so a new PAL_SESSION_DB is read."""
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:  # noqa: BLE001
                pass
        _conn = None


def save(session_id: str, history: list[dict], cwd: str = "", model: str = "") -> bool:
    """Upsert one chat session. Returns True on success, False if storage is
    unavailable (caller continues regardless)."""
    if not session_id:
        return False
    with _lock:
        conn = _connect()
        if conn is None:
            return False
        try:
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(id, cwd, model, turns, updated_at, history) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, cwd, model, len(history), time.time(),
                 json.dumps(history, ensure_ascii=False)),
            )
            conn.commit()
            return True
        except Exception as exc:  # noqa: BLE001
            log.debug("session_store save failed: %s", exc)
            return False


def load(session_id: str) -> list[dict] | None:
    """Return a session's history list, or None if missing/unavailable."""
    with _lock:
        conn = _connect()
        if conn is None:
            return None
        try:
            row = conn.execute("SELECT history FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
        except Exception as exc:  # noqa: BLE001
            log.debug("session_store load failed: %s", exc)
            return None
    if not row:
        return None
    try:
        data = json.loads(row[0])
        return data if isinstance(data, list) else None
    except (ValueError, TypeError):
        return None


def recent(limit: int = 10) -> list[dict]:
    """Most-recently-updated sessions, newest first:
    [{id, cwd, model, turns, updated_at}]. Empty if storage is unavailable."""
    with _lock:
        conn = _connect()
        if conn is None:
            return []
        try:
            rows = conn.execute(
                "SELECT id, cwd, model, turns, updated_at FROM chat_sessions "
                "ORDER BY updated_at DESC LIMIT ?",
                (max(1, limit),),
            ).fetchall()
        except Exception as exc:  # noqa: BLE001
            log.debug("session_store recent failed: %s", exc)
            return []
    return [
        {"id": r[0], "cwd": r[1], "model": r[2], "turns": r[3], "updated_at": r[4]}
        for r in rows
    ]


def latest() -> dict | None:
    """The single most-recent session summary, or None."""
    rows = recent(1)
    return rows[0] if rows else None
