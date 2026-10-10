"""
Unit & Integration Tests for Sauron Shared Memory System
"""

import os
import pytest
from utils.shared_memory import (
    SharedMemoryStore,
    ContextCompiler,
    ProvenanceType,
    MemoryItem,
)
from utils.storage_backend import InMemoryStorage, SqliteStorage


@pytest.fixture
def memory_store(tmp_path):
    # Use temporary sqlite storage for isolated testing
    db_file = str(tmp_path / "test_memory.db")
    storage = SqliteStorage(db_path=db_file)
    store = SharedMemoryStore(storage=storage)
    yield store
    storage.shutdown()


def test_store_and_retrieve_memory(memory_store):
    item = memory_store.store_memory(
        key="user.name",
        content="Yousry",
        provenance=ProvenanceType.USER_CONFIRMED,
    )
    assert item.key == "user.name"
    assert item.content == "Yousry"

    retrieved = memory_store.get_memory("user.name")
    assert retrieved is not None
    assert retrieved.content == "Yousry"
    assert retrieved.provenance == ProvenanceType.USER_CONFIRMED


def test_cross_model_fact_retrieval(memory_store):
    """Simulate Model A storing fact, and Model B & C retrieving it."""
    # Model A (e.g. Claude) receives: "My name is Yousry"
    memory_store.auto_extract_facts("Hello, my name is Yousry.", role="user")

    # Model B (e.g. Gemini) asks "what is my name?" via deterministic lookup
    ans_b = memory_store.deterministic_fact_lookup("What is my name?")
    assert ans_b == "Your name is Yousry."

    # Model C (e.g. OpenAI) compiles context block for query
    compiler = ContextCompiler(memory_store=memory_store)
    ctx_c = compiler.compile_context("What is my name?")
    assert "Yousry" in ctx_c
    assert "user.name" in ctx_c


def test_conflict_resolution_user_override(memory_store):
    # First: Model infers a name
    memory_store.store_memory(
        key="user.name",
        content="Alex",
        provenance=ProvenanceType.MODEL_INFERENCE,
    )
    assert memory_store.get_memory("user.name").content == "Alex"

    # User explicitly corrects it
    memory_store.store_memory(
        key="user.name",
        content="Yousry",
        provenance=ProvenanceType.USER_CONFIRMED,
    )
    assert memory_store.get_memory("user.name").content == "Yousry"

    # Subsequent model inference tries to overwrite with stale inference
    memory_store.store_memory(
        key="user.name",
        content="Bob",
        provenance=ProvenanceType.MODEL_INFERENCE,
    )
    # Must remain Yousry because USER_CONFIRMED takes precedence!
    assert memory_store.get_memory("user.name").content == "Yousry"


def test_context_compiler_token_budgeting(memory_store):
    for i in range(10):
        memory_store.store_memory(
            key=f"fact.{i}",
            content=f"This is test fact number {i} with some long detailed description.",
        )

    compiler = ContextCompiler(memory_store=memory_store)
    compiled = compiler.compile_context("test fact", max_tokens=100)
    assert "=== SAURON SHARED MEMORY" in compiled
    # Budgeting should cap output, not dump all 10 items if budget is small
    assert len(compiled.splitlines()) < 15
