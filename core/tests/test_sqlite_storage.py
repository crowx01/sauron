"""Tests for the durable SQLite backend and the REPL session store."""

from __future__ import annotations

import importlib

from utils.storage_backend import SqliteStorage


def test_sqlite_round_trip_and_setex(tmp_path):
    db = str(tmp_path / "s.db")
    s = SqliteStorage(db)
    s.set_with_ttl("k1", 60, "v1")
    s.setex("k2", 60, "v2")
    assert s.get("k1") == "v1"
    assert s.get("k2") == "v2"
    assert s.get("missing") is None
    s.shutdown()


def test_sqlite_ttl_expiry(tmp_path):
    s = SqliteStorage(str(tmp_path / "s.db"))
    s.set_with_ttl("k", -1, "stale")  # already expired
    assert s.get("k") is None          # lazy expiry on read
    s.shutdown()


def test_sqlite_survives_reopen(tmp_path):
    db = str(tmp_path / "s.db")
    s1 = SqliteStorage(db)
    s1.set_with_ttl("persist", 3600, "value")
    s1.shutdown()
    # a brand-new backend over the same file == a process restart
    s2 = SqliteStorage(db)
    assert s2.get("persist") == "value"
    s2.shutdown()


def test_storage_backend_selects_sqlite(monkeypatch, tmp_path):
    import utils.storage_backend as sb

    monkeypatch.setenv("PAL_STORAGE", "sqlite")
    monkeypatch.setenv("PAL_STORAGE_DB", str(tmp_path / "sel.db"))
    sb._storage_instance = None  # reset singleton
    inst = sb.get_storage_backend()
    assert isinstance(inst, sb.SqliteStorage)
    sb._storage_instance = None


def test_storage_backend_defaults_to_memory(monkeypatch):
    import utils.storage_backend as sb

    monkeypatch.delenv("PAL_STORAGE", raising=False)
    sb._storage_instance = None
    inst = sb.get_storage_backend()
    assert isinstance(inst, sb.InMemoryStorage)
    sb._storage_instance = None


# ----- REPL session store -----------------------------------------------------
def _fresh_store(monkeypatch, tmp_path):
    monkeypatch.setenv("PAL_SESSION_DB", str(tmp_path / "sessions.db"))
    from providers.router import session_store

    importlib.reload(session_store)
    session_store.reset()
    return session_store


def test_session_store_save_load(monkeypatch, tmp_path):
    ss = _fresh_store(monkeypatch, tmp_path)
    hist = [{"role": "user", "content": "scan x"}, {"role": "assistant", "content": "done"}]
    assert ss.save("sid-1", hist, cwd="/work", model="gpt-oss-20b") is True
    assert ss.load("sid-1") == hist
    assert ss.load("nope") is None


def test_session_store_save_is_upsert_and_recent_orders(monkeypatch, tmp_path):
    ss = _fresh_store(monkeypatch, tmp_path)
    ss.save("a", [{"role": "user", "content": "1"}])
    ss.save("b", [{"role": "user", "content": "1"}, {"role": "assistant", "content": "2"}])
    ss.save("a", [{"role": "user", "content": "updated"}])  # upsert -> a becomes newest
    rows = ss.recent(10)
    assert [r["id"] for r in rows][0] == "a"           # most-recently-updated first
    assert ss.latest()["id"] == "a"
    assert ss.load("a") == [{"role": "user", "content": "updated"}]
    assert next(r for r in rows if r["id"] == "b")["turns"] == 2


def test_session_store_degrades_when_unavailable(monkeypatch, tmp_path):
    ss = _fresh_store(monkeypatch, tmp_path)
    # point at an unwritable path and drop the cached connection
    monkeypatch.setenv("PAL_SESSION_DB", "/proc/nonexistent-dir/x.db")
    ss.reset()
    assert ss.save("x", [{"role": "user", "content": "y"}]) is False  # no crash
    assert ss.load("x") is None
    assert ss.recent() == []
    ss.reset()
