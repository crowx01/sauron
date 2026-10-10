"""
Sauron Shared Task State & Debate Reasoning Compact Briefs

Provides structured shared task state for multi-model ensembles, debates, and subagent missions.
Prevents sending massive raw transcripts between models by using compact task briefs with
traceable evidence references and confirmed findings.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class EvidenceItem(BaseModel):
    """Traceable piece of evidence from tool execution or code inspection."""
    id: str = Field(default_factory=lambda: f"ev_{uuid.uuid4().hex[:8]}")
    description: str
    source: str                        # e.g. "pytest", "tool:grep", "file:cli.py"
    content_snippet: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class FindingItem(BaseModel):
    """Claim or discovery made during a multi-model debate or mission."""
    id: str = Field(default_factory=lambda: f"f_{uuid.uuid4().hex[:8]}")
    claim: str
    status: str = "proposed"            # "proposed", "confirmed", "rejected"
    evidence_ids: List[str] = Field(default_factory=list)
    proposed_by: str = "agent"          # model name or agent role
    confidence: float = 0.8


class SharedTaskState(BaseModel):
    """Structured shared task state for multi-model debate / mission sessions."""
    task_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    objective: str
    constraints: List[str] = Field(default_factory=list)
    hypotheses: List[str] = Field(default_factory=list)
    confirmed_findings: List[FindingItem] = Field(default_factory=list)
    unresolved_questions: List[str] = Field(default_factory=list)
    completed_actions: List[str] = Field(default_factory=list)
    evidence_log: List[EvidenceItem] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def add_evidence(self, description: str, source: str, snippet: Optional[str] = None) -> EvidenceItem:
        ev = EvidenceItem(description=description, source=source, content_snippet=snippet)
        self.evidence_log.append(ev)
        self.updated_at = datetime.now(timezone.utc).isoformat()
        return ev

    def add_finding(self, claim: str, proposed_by: str, status: str = "proposed", evidence_ids: Optional[List[str]] = None) -> FindingItem:
        finding = FindingItem(
            claim=claim,
            proposed_by=proposed_by,
            status=status,
            evidence_ids=evidence_ids or [],
        )
        self.confirmed_findings.append(finding)
        self.updated_at = datetime.now(timezone.utc).isoformat()
        return finding


class TaskStateCompiler:
    """Formats a compact, token-efficient brief for debate subagents / participants."""

    @staticmethod
    def compile_brief(state: SharedTaskState, role_name: str = "Participant", max_tokens: int = 500) -> str:
        lines = [
            f"=== SAURON SHARED TASK BRIEF ({role_name}) ===",
            f"Task Objective: {state.objective}",
        ]

        if state.constraints:
            lines.append("Constraints: " + "; ".join(state.constraints))

        if state.confirmed_findings:
            lines.append("\nConfirmed Findings & Evidence:")
            for f in state.confirmed_findings:
                status_mark = "✓" if f.status == "confirmed" else "?"
                lines.append(f"  [{status_mark}] {f.claim} (By: {f.proposed_by})")

        if state.unresolved_questions:
            lines.append("\nUnresolved Questions:")
            for q in state.unresolved_questions:
                lines.append(f"  - {q}")

        if state.completed_actions:
            lines.append("\nCompleted Actions:")
            for a in state.completed_actions[-3:]:  # Keep last 3 actions
                lines.append(f"  - {a}")

        lines.append("=== END SAURON TASK BRIEF ===")
        brief = "\n".join(lines)
        return brief
