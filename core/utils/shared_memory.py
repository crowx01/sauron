"""
Sauron Shared Intelligence Memory & Context Compiler

Provides a canonical, provider-independent persistent memory store and selective
context compiler for Sauron. Enables cross-model fact retrieval (Claude, Gemini,
OpenAI, etc.) without transmitting full raw transcripts or blindly dumping entire
databases into prompts.

Key Components:
1. SharedMemoryStore: Persistent KV/Fact store with provenance & conflict resolution.
2. ContextCompiler: Token-budgeted selective context compiler for prompts.
3. Provenance & Conflict Resolution: User corrections override stale facts.
4. Auto Fact Extraction: Detects direct user assertions ("My name is ...").
"""

from __future__ import annotations

import enum
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class ProvenanceType(str, enum.Enum):
    USER_CONFIRMED = "USER_CONFIRMED"  # Fact explicitly stated by user (highest authority)
    TOOL_RESULT = "TOOL_RESULT"        # Derived from tool execution/file read
    DIRECT_OBSERVATION = "DIRECT_OBSERVATION"  # System/runtime environment observation
    MODEL_INFERENCE = "MODEL_INFERENCE" # Inferred by an LLM model (requires verification)


class MemoryItem(BaseModel):
    """Single factual memory entry with provenance and scope."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    key: str                           # Short key or topic (e.g. "user.name", "project.language")
    content: str                       # Detailed factual statement
    provenance: ProvenanceType = ProvenanceType.USER_CONFIRMED
    scope: str = "global"              # "global", "project", or "conversation"
    confidence: float = 1.0            # 0.0 to 1.0 confidence score
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SharedMemoryStore:
    """Canonical, provider-independent memory store for all model interactions.
    
    Uses Sauron's storage backend (SQLite/InMemory) to ensure facts persist
    across requests, sessions, and different AI model providers.
    """

    KEY_PREFIX = "sauron:memory:"
    INDEX_KEY = "sauron:memory_index"

    def __init__(self, storage=None):
        if storage is None:
            from utils.storage_backend import get_storage_backend
            storage = get_storage_backend()
        self._storage = storage

    def _get_index(self) -> List[str]:
        """Fetch list of all memory keys."""
        raw = self._storage.get(self.INDEX_KEY)
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    def _save_index(self, index: List[str]) -> None:
        """Save list of all memory keys (TTL: 1 year)."""
        self._storage.setex(self.INDEX_KEY, 31536000, json.dumps(list(set(index))))

    def store_memory(
        self,
        key: str,
        content: str,
        provenance: ProvenanceType = ProvenanceType.USER_CONFIRMED,
        scope: str = "global",
        confidence: float = 1.0,
        metadata: Optional[Dict[str, Any]] = None,
        ttl_seconds: int = 31536000,  # 1 year default for durable facts
    ) -> MemoryItem:
        """Store or update a memory fact with conflict resolution."""
        key_clean = key.strip().lower()
        now = datetime.now(timezone.utc).isoformat()

        # Check existing memory for conflict resolution
        existing = self.get_memory(key_clean)
        if existing:
            # User confirmed facts override non-user facts
            if (
                existing.provenance == ProvenanceType.USER_CONFIRMED
                and provenance != ProvenanceType.USER_CONFIRMED
            ):
                logger.debug("Ignoring update to USER_CONFIRMED memory '%s' from %s", key_clean, provenance)
                return existing

            item = MemoryItem(
                id=existing.id,
                key=key_clean,
                content=content.strip(),
                provenance=provenance,
                scope=scope,
                confidence=confidence,
                created_at=existing.created_at,
                updated_at=now,
                metadata=metadata or existing.metadata,
            )
        else:
            item = MemoryItem(
                key=key_clean,
                content=content.strip(),
                provenance=provenance,
                scope=scope,
                confidence=confidence,
                created_at=now,
                updated_at=now,
                metadata=metadata or {},
            )

        storage_key = f"{self.KEY_PREFIX}{key_clean}"
        self._storage.setex(storage_key, ttl_seconds, item.model_dump_json())

        # Update index
        index = self._get_index()
        if key_clean not in index:
            index.append(key_clean)
            self._save_index(index)

        logger.info("[SHARED MEMORY] Stored memory '%s' (Provenance: %s)", key_clean, provenance.value)
        return item

    def get_memory(self, key: str) -> Optional[MemoryItem]:
        """Get memory item by key."""
        key_clean = key.strip().lower()
        storage_key = f"{self.KEY_PREFIX}{key_clean}"
        raw = self._storage.get(storage_key)
        if not raw:
            return None
        try:
            return MemoryItem.model_validate_json(raw)
        except Exception as e:
            logger.warning("Failed to deserialize memory '%s': %s", key_clean, e)
            return None

    def delete_memory(self, key: str) -> bool:
        """Delete a stored memory."""
        key_clean = key.strip().lower()
        storage_key = f"{self.KEY_PREFIX}{key_clean}"
        # Setting 1s TTL effectively deletes it in our storage interface
        self._storage.setex(storage_key, 1, "")
        index = self._get_index()
        if key_clean in index:
            index.remove(key_clean)
            self._save_index(index)
        return True

    def list_memories(self, scope: Optional[str] = None) -> List[MemoryItem]:
        """List all valid memories, optionally filtered by scope."""
        index = self._get_index()
        results = []
        for k in index:
            item = self.get_memory(k)
            if item:
                if scope is None or item.scope == scope:
                    results.append(item)
        return results

    def search_memories(self, query: str, limit: int = 5, scope: Optional[str] = None) -> List[MemoryItem]:
        """Relevance search over stored memories using keyword matching & scoring."""
        all_items = self.list_memories(scope=scope)
        if not all_items or not query.strip():
            return all_items[:limit]

        query_words = set(re.findall(r"\w+", query.lower()))
        scored: List[tuple[float, MemoryItem]] = []

        for item in all_items:
            score = 0.0
            item_text = f"{item.key} {item.content}".lower()
            item_words = set(re.findall(r"\w+", item_text))

            # Exact key match boost
            if item.key in query.lower():
                score += 5.0

            # Word overlap
            overlap = len(query_words.intersection(item_words))
            score += overlap * 1.5

            # Provenance weighting
            if item.provenance == ProvenanceType.USER_CONFIRMED:
                score += 2.0

            if score > 0:
                scored.append((score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored[:limit]]

    def deterministic_fact_lookup(self, query: str) -> Optional[str]:
        """Directly answer simple factual queries without needing an LLM call if exact match exists.
        
        Example: "What is my name?" -> matches memory key "user.name" -> returns content.
        """
        q = query.strip().lower()

        # Common intent patterns
        name_patterns = [
            r"what('s| is) my name",
            r"who am i",
            r"do you know my name",
            r"what did i tell you my name was",
        ]
        for pat in name_patterns:
            if re.search(pat, q):
                mem = self.get_memory("user.name") or self.get_memory("user_name")
                if mem:
                    return f"Your name is {mem.content}."

        # General key lookup
        memories = self.list_memories()
        for mem in memories:
            if mem.key and mem.key in q:
                return f"{mem.key}: {mem.content}"

        return None

    def auto_extract_facts(self, text: str, role: str = "user") -> List[MemoryItem]:
        """Scan incoming text to automatically extract user assertions like:
        "My name is Yousry" -> stores key "user.name", content "Yousry"
        "Project language is Python" -> stores key "project.language"
        """
        if role != "user" or not text:
            return []

        extracted = []

        # Rule 1: My name is X
        name_match = re.search(r"\bmy name is ([A-Z][a-zA-Z0-9_\-\s]{1,30})\b", text, re.IGNORECASE)
        if name_match:
            name_val = name_match.group(1).strip(". ,!")
            item = self.store_memory(
                key="user.name",
                content=name_val,
                provenance=ProvenanceType.USER_CONFIRMED,
                scope="global",
            )
            extracted.append(item)

        # Rule 2: Prefer/Use X framework/language/database
        lang_match = re.search(r"\b(using|prefer|project language is|stack is) ([A-Za-z0-9_\+#\.\s]{2,25})\b", text, re.IGNORECASE)
        if lang_match:
            val = lang_match.group(2).strip(". ,!")
            item = self.store_memory(
                key="project.stack",
                content=val,
                provenance=ProvenanceType.USER_CONFIRMED,
                scope="project",
            )
            extracted.append(item)

        return extracted


class ContextCompiler:
    """Compiles a compact, token-budgeted memory context block for model requests."""

    def __init__(self, memory_store: Optional[SharedMemoryStore] = None):
        self.memory_store = memory_store or SharedMemoryStore()

    def compile_context(
        self,
        query_or_prompt: str,
        max_tokens: int = 400,
        scope: Optional[str] = None,
    ) -> str:
        """Compile relevant facts into a compact, formatted system context block.
        
        Will NOT inject full DB; selects top relevant items and formats them cleanly.
        """
        relevant_memories = self.memory_store.search_memories(query_or_prompt, limit=5, scope=scope)
        if not relevant_memories:
            return ""

        lines = [
            "=== SAURON SHARED MEMORY (PERSISTENT FACTS) ===",
            "The following authoritative user & project facts are retrieved from shared memory:",
        ]

        token_estimate = 40
        for item in relevant_memories:
            fact_line = f"- [{item.key}] ({item.provenance.value}): {item.content}"
            # Rough token count estimate (1 token ~ 4 chars)
            line_tokens = len(fact_line) // 4 + 2
            if token_estimate + line_tokens > max_tokens:
                break
            lines.append(fact_line)
            token_estimate += line_tokens

        lines.append("=== END SAURON SHARED MEMORY ===")
        return "\n".join(lines)


# Singleton instances
_shared_memory_instance: Optional[SharedMemoryStore] = None


def get_shared_memory_store() -> SharedMemoryStore:
    global _shared_memory_instance
    if _shared_memory_instance is None:
        _shared_memory_instance = SharedMemoryStore()
    return _shared_memory_instance
