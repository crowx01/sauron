"""Auto-fallback chain: try every model in a category before surfacing failure.

Motivation: providers hit rate-limits, quota exhaustion, and silent policy blocks
constantly. Rather than bounce failures back to the caller after one attempt,
this module cycles through same-category alternatives from ``~/.pal/env.json``
until one succeeds or the list is exhausted.

Triggers a fallback on:
  - HTTP status 413 (payload too large) / 402 (credits) / 429 (rate) / 503 (down)
  - Silent policy blocks: response text containing markers like
    "Response blocked or incomplete" or "Finish reason: Unknown"
  - Provider deprecation 404s already handled by self_heal.apply_after_retry

Env: PAL_FALLBACK=0 disables (default on). PAL_FALLBACK_MAX caps attempts (default 8).
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

FALLBACK_TRIGGERS: frozenset[int] = frozenset({402, 413, 429, 503})

SILENT_BLOCK_MARKERS: tuple[str, ...] = (
    "response blocked or incomplete",
    "finish reason: unknown",
    "content_filter",
    "safety block",
    "content policy",
    "response was blocked",
)

# A 400 is normally a client error (don't retry), EXCEPT when it means the model
# id itself doesn't exist at the provider — a phantom/retired catalog entry (e.g.
# a fallback target routed to the wrong provider). Those must SKIP to the next
# peer, not raise and kill the whole chain (observed 2026-10-08:
# openai/gpt-5.1-codex-mini 400'd model_not_found on HuggingFace and crashed a run).
_MODEL_GONE_MARKERS: tuple[str, ...] = (
    "model_not_found",
    "model not found",
    "does not exist",
    "no such model",
    "unknown model",
    "model_not_exist",
    "invalid model",
)


# --- session provider quarantine -------------------------------------------
# Providers that fail with a credit/quota-exhaustion error (402, "no remaining
# credits") stay broken for the whole run, so retrying them on every mission step
# just burns round-trips (observed 2026-10-08: HuggingFace 402'd on every call
# yet stayed in the chain). Once a provider trips this, we skip it for the rest
# of the process. Env PAL_QUARANTINE=0 disables.
_QUARANTINE: set[str] = set()

_CREDIT_MARKERS: tuple[str, ...] = (
    "no remaining credits",
    "insufficient credits",
    "insufficient_quota",
    "quota exceeded",
    "payment required",
    "billing",
)


def _quarantine_enabled() -> bool:
    return os.getenv("PAL_QUARANTINE", "1") not in ("0", "false", "no")


def _provider_prefix(model: str) -> str:
    """Provider id = text before the first '/' (e.g. 'meta-llama/Llama-3…' → 'meta-llama')."""
    return (model or "").split("/", 1)[0].strip().lower()


def _is_credit_failure(status: int | None, text: str) -> bool:
    if status == 402:
        return True
    low = (text or "").lower()
    return any(m in low for m in _CREDIT_MARKERS)


def quarantine(model: str) -> None:
    if _quarantine_enabled():
        pref = _provider_prefix(model)
        if pref and pref not in _QUARANTINE:
            _QUARANTINE.add(pref)
            log.warning("fallback: quarantined provider '%s' for this run (credit/quota failure)", pref)


def is_quarantined(model: str) -> bool:
    return _quarantine_enabled() and _provider_prefix(model) in _QUARANTINE


def reset_quarantine() -> None:
    """Test helper — clear the session quarantine set."""
    _QUARANTINE.clear()


def _env_path() -> Path:
    return Path(os.getenv("PAL_ENV_JSON", str(Path.home() / ".pal/env.json")))


def is_enabled() -> bool:
    return os.getenv("PAL_FALLBACK", "1") not in ("0", "false", "no")


def _max_attempts() -> int:
    try:
        return max(1, int(os.getenv("PAL_FALLBACK_MAX", "8")))
    except ValueError:
        return 8


@lru_cache(maxsize=8)
def _load_categories_from(path_str: str) -> dict[str, list[str]]:
    p = Path(path_str)
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError) as exc:
        log.debug("fallback: cannot load %s (%s)", p, exc)
        return {}
    return dict(data.get("categories", {}) or {})


def _load_categories() -> dict[str, list[str]]:
    return _load_categories_from(str(_env_path()))


def reset_cache() -> None:
    """Test helper — drop cached categories map so env changes are re-read."""
    _load_categories_from.cache_clear()


def category_for(model: str) -> str | None:
    for cat, models in _load_categories().items():
        if model in models:
            return cat
    return None


def chain_for(model: str) -> list[str]:
    """Ordered list of fallback models: same-category peers after `model`,
    then peers before `model` (wrap-around), de-duplicated."""
    cat = category_for(model)
    if not cat:
        return []
    peers = _load_categories().get(cat, [])
    try:
        i = peers.index(model)
        rotated = peers[i + 1 :] + peers[:i]
    except ValueError:
        rotated = list(peers)
    seen: set[str] = {model}
    ordered: list[str] = []
    for m in rotated:
        if m not in seen:
            seen.add(m)
            ordered.append(m)
    return ordered


def should_fallback(status_code: int | None, response_text: str | Exception) -> bool:
    if status_code in FALLBACK_TRIGGERS:
        return True
    haystack = str(response_text or "").lower()
    # a dead/phantom model id (400 model-not-found) must skip to the next peer
    if status_code == 400 and any(m in haystack for m in _MODEL_GONE_MARKERS):
        return True
    if not haystack:
        return False
    if any(m in haystack for m in _MODEL_GONE_MARKERS):
        return True
    return any(marker in haystack for marker in SILENT_BLOCK_MARKERS)


def _extract_status_and_text(exc: Exception) -> tuple[int | None, str]:
    """Best-effort pull of an HTTP status + human-readable text from an exception."""
    text = str(exc)
    status: int | None = None
    for attr in ("status_code", "http_status", "code"):
        val = getattr(exc, attr, None)
        if isinstance(val, int) and 100 <= val <= 599:
            status = val
            break
    resp = getattr(exc, "response", None)
    if resp is not None and status is None:
        val = getattr(resp, "status_code", None)
        if isinstance(val, int):
            status = val
    # scrape common inline codes: "Error code: 413" / "429" / "402"
    if status is None:
        import re

        m = re.search(r"\b(4\d\d|5\d\d)\b", text)
        if m:
            status = int(m.group(1))
    return status, text


def _merge_chain(model: str, extra_chain: Iterable[str] | None) -> list[str]:
    """Primary first, then static same-category peers, then any caller-supplied
    (e.g. capability-matched catalog) peers — de-duplicated, order preserved."""
    ordered: list[str] = [model, *chain_for(model)]
    if extra_chain:
        ordered.extend(extra_chain)
    seen: set[str] = set()
    out: list[str] = []
    for m in ordered:
        if not m or m in seen:
            continue
        seen.add(m)
        # never drop the primary; skip peers whose provider is quarantined
        if m != model and is_quarantined(m):
            continue
        out.append(m)
    return out[: _max_attempts()]


def _reorder_for_oversize(candidates: list[str]) -> list[str]:
    """On a 413, prefer the biggest-context peers first so an oversize request
    jumps straight to a model that can hold it rather than walking small peers."""
    try:
        from providers.router import size_guard

        return sorted(candidates, key=lambda m: size_guard.cap_for(m), reverse=True)
    except Exception:  # noqa: BLE001
        return candidates


def call_with_fallback(
    call: Callable[[str], object],
    model: str,
    *,
    on_switch: Callable[[str, str, str], None] | None = None,
    extra_chain: Iterable[str] | None = None,
) -> object:
    """Invoke ``call(model)`` and, on a fallback-worthy failure, retry against
    each peer in order. Raises the LAST exception when the whole chain is
    exhausted.

    The chain is the primary model, then its static same-category peers from
    ``~/.pal/env.json``, then ``extra_chain`` — a caller-supplied list of
    already capability-matched, available peers (the dispatch layer fills this
    from the catalog so fallback never silently drops to a model that cannot do
    tools or hold the prompt, and so fallback works even with no static config).

    ``on_switch(prev_model, next_model, reason)`` fires before every switch —
    use it to log the trail to the operator.
    """
    if not is_enabled():
        return call(model)

    attempted: list[str] = [model]
    chain = _merge_chain(model, extra_chain)
    last_exc: Exception | None = None

    i = 0
    while i < len(chain):
        candidate = chain[i]
        try:
            result = call(candidate)
        except Exception as exc:  # noqa: BLE001 — we deliberately catch to reroute
            status, text = _extract_status_and_text(exc)
            if not should_fallback(status, text):
                raise
            last_exc = exc
            # credit/quota exhaustion → quarantine the provider and prune its
            # peers from the untried tail so we stop hitting a dead account.
            if _is_credit_failure(status, text):
                quarantine(candidate)
                chain = chain[: i + 1] + [m for m in chain[i + 1 :] if not is_quarantined(m)]
            # payload-too-large → reorder the untried tail biggest-context first.
            if status == 413 and i + 1 < len(chain):
                chain = chain[: i + 1] + _reorder_for_oversize(chain[i + 1 :])
            if i + 1 < len(chain):
                reason = f"status={status} | {text[:120]}"
                log.warning("fallback: %s → %s (%s)", candidate, chain[i + 1], reason)
                if on_switch:
                    try:
                        on_switch(candidate, chain[i + 1], reason)
                    except Exception:  # noqa: BLE001
                        pass
                attempted.append(chain[i + 1])
            i += 1
            continue
        # Non-exception result: check for embedded silent-block markers
        result_text = _stringify_result(result)
        if should_fallback(None, result_text):
            if i + 1 < len(chain):
                reason = f"silent-block on {candidate}"
                log.warning("fallback: %s → %s (%s)", candidate, chain[i + 1], reason)
                if on_switch:
                    try:
                        on_switch(candidate, chain[i + 1], reason)
                    except Exception:  # noqa: BLE001
                        pass
                attempted.append(chain[i + 1])
                last_exc = RuntimeError(f"silent-block on {candidate}")
                i += 1
                continue
            # exhausted — return the last (blocked) result rather than raise
            return result
        return result

    # Whole chain exhausted with failures
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"fallback chain exhausted for {model}; tried {attempted}")


def _stringify_result(result: object) -> str:
    """Coerce a provider response into text for silent-block scanning."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    for attr in ("content", "text", "message"):
        val = getattr(result, attr, None)
        if isinstance(val, str) and val:
            return val
    try:
        return json.dumps(result, default=str)[:2000]
    except (TypeError, ValueError):
        return str(result)[:2000]


def describe_chain(model: str) -> Iterable[str]:
    """Introspection helper: full ordered attempt list a real call would try."""
    return [model, *chain_for(model)][: _max_attempts()]
