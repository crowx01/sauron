import os
import tempfile
import pytest

from providers.router import session_store
from providers.router import chat_history


def test_session_store_crud():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "sessions.db")
        history_dir = os.path.join(tmpdir, "history")
        os.environ["PAL_SESSION_DB"] = db_path
        os.environ["PAL_CHAT_HISTORY_DIR"] = history_dir
        session_store.reset()

        # Save session
        sess_id = "test_sess_1"
        history_data = [{"role": "user", "content": "hello"}]
        assert session_store.save(sess_id, history_data, cwd="/tmp", model="qwen3")

        # Load session
        loaded = session_store.load(sess_id)
        assert loaded == history_data

        # Recent sessions
        recents = session_store.recent(10)
        assert len(recents) == 1
        assert recents[0]["id"] == sess_id

        # Delete single session
        # Create a mock history file to verify file cleanup
        os.makedirs(history_dir, exist_ok=True)
        h_file = chat_history.history_path(sess_id)
        h_file.write_text("test line\n")

        assert session_store.delete_session(sess_id)
        assert session_store.load(sess_id) is None
        assert not h_file.exists()

        # Save multiple sessions and clear all
        session_store.save("sess_a", history_data, cwd="/tmp", model="qwen3")
        session_store.save("sess_b", history_data, cwd="/tmp", model="qwen3")
        h_file_a = chat_history.history_path("sess_a")
        h_file_a.write_text("line A\n")

        assert len(session_store.recent(10)) == 2
        assert session_store.clear_all()
        assert len(session_store.recent(10)) == 0
        assert not h_file_a.exists()
