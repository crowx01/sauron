"""Centralized provider dispatch for REPL-side callers (/tools, /debate).

`tools/simple/base.py` already wraps the MCP tool path with size_guard
pre-flight rerouting, fallback_chain retries, and refusal/episode recording
(server.py's ``handle_call_tool``). The chat REPL's ``/tools`` and ``/debate``
commands call ``provider.generate_content`` directly, bypassing all of that.

This module gives both call sites the same treatment through one function:
size-guard reroute -> fallback-chain call -> refusal classification ->
episode_store recording. Recording is prompt-hash only (episode_store.record
hashes internally; the raw prompt is never persisted).
"""

from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)


def _capability_chain(model: str, prompt: str, tools: list | None, category: str) -> list[str]:
    """Available, capability-matched fallback peers for ``model`` from the
    catalog, best-first, excluding the primary. Used to seed the fallback chain
    so a reroute never drops to a model that cannot do what the call needs
    (tool-calling, or holding a prompt this large). Best-effort: returns [] if
    the catalog is unavailable so dispatch behaviour is unchanged without it.
    """
    try:
        from providers.registry import ModelProviderRegistry
        from providers.router import catalog

        need = catalog.Need(
            tools=bool(tools),
            # chars/4 ≈ tokens: only fall back to models that can hold the prompt
            min_context=max(0, len(prompt or "") // 4),
            # bulk/long-context categories may use free-tier routes; others stay off it
            allow_free_tier=category in ("long_context_bulk",),
        )
        primary_names = {model.lower()}
        try:
            prov = ModelProviderRegistry.get_provider_for_model(model)
            if prov is not None:
                primary_names |= {a.lower() for a in getattr(prov, "aliases", []) or []}
        except Exception:  # noqa: BLE001
            pass
        out: list[str] = []
        for e in catalog.select(need):
            if e.model.lower() in primary_names or e.model in out:
                continue
            out.append(e.model)
        return out[:8]
    except Exception as exc:  # noqa: BLE001 - never let routing enrichment break a call
        log.debug("capability-chain unavailable: %s", exc)
        return []


def generate(
    model: str,
    prompt: str,
    system: str | None = None,
    *,
    temperature: float = 0.3,
    category: str = "",
    tool: str = "repl",
    max_output_tokens: int | None = None,
    tools: list | None = None,
):
    """Resolve a provider for ``model``, reroute/fall back as needed, and
    record the outcome (success/refusal/error) to episode_store + refusal_memory.

    Returns the ModelResponse on success; raises on total fallback exhaustion.
    """
    from providers.registry import ModelProviderRegistry

    # Caveman-ultra: prepend a compression instruction so plain chat responses
    # are maximally compressed. NEVER for tool/mission/debate calls, where the
    # model must emit exact tool-call / structured syntax (compressing that
    # breaks execution, e.g. gpt-oss narrating "wrote file" without a real call).
    from providers.router import caveman, episode_store, refusal_memory
    from providers.router.fallback_chain import call_with_fallback
    from providers.router.size_guard import check_or_reroute

    if caveman.is_enabled() and category not in ("tools", "mission", "debate"):
        _cv = caveman.system_prefix()
        if _cv:
            system = (_cv + "\n\n" + system) if system else _cv

    dispatch_model = model
    ok, hint = check_or_reroute(dispatch_model, prompt)
    if not ok and hint and hint.startswith("route:") and hint != "route:none":
        alt = hint.split(":", 1)[1]
        log.warning("size-guard: %s over cap → pre-routing to %s", dispatch_model, alt)
        dispatch_model = alt

    def _invoke(_model: str):
        from providers.router import key_pool

        prov = ModelProviderRegistry.get_provider_for_model(_model)
        if prov is None:
            raise RuntimeError(f"no provider for {_model}")
        _name = None
        _keys: list[str] = []
        if key_pool.is_enabled():
            try:
                _name = key_pool.name_for_type(getattr(prov.get_provider_type(), "value", ""))
                _keys = key_pool.keys_for(_name) if _name else []
            except Exception:
                _name, _keys = None, []
        _last = None
        for _ in range(max(1, len(_keys))):
            try:
                _resp = prov.generate_content(
                    prompt,
                    _model,
                    system,
                    temperature,
                    max_output_tokens=max_output_tokens,
                    tools=tools,
                )
                if _name and getattr(prov, "api_key", None):
                    key_pool.mark_ok(_name, prov.api_key)
                return _resp
            except Exception as exc:  # noqa: BLE001 - reclassified by caller
                _last = exc
                if (
                    _keys
                    and key_pool.is_rate_or_credit_error(str(exc))
                    and hasattr(prov, "set_api_key")
                ):
                    _nk = key_pool.rotate(_name, getattr(prov, "api_key", None), type(exc).__name__)
                    if _nk and _nk != getattr(prov, "api_key", None):
                        prov.set_api_key(_nk)
                        continue
                raise
        if _last:
            raise _last
        raise RuntimeError(f"no provider for {_model}")

    t0 = time.time()
    extra_chain = _capability_chain(dispatch_model, prompt, tools, category)
    try:
        resp = call_with_fallback(_invoke, dispatch_model, extra_chain=extra_chain)
    except Exception as exc:
        lat_ms = int((time.time() - t0) * 1000)
        tag = refusal_memory.classify(str(exc))
        if tag:
            refusal_memory.record(model, category, tag)
        episode_store.record(
            model,
            category,
            "refusal" if (tag or "").startswith("refusal:") else "error",
            latency_ms=lat_ms,
            prompt=prompt,
            err_class=refusal_memory.classify_class(tag or str(exc)),
            tool=tool,
            reason=tag or str(exc),
        )
        raise

    lat_ms = int((time.time() - t0) * 1000)
    text = getattr(resp, "content", "") or ""
    tag = refusal_memory.classify(text)
    is_refusal = bool(tag and tag.startswith("refusal:"))
    if is_refusal:
        refusal_memory.record(model, category, tag)
    else:
        refusal_memory.record_success(model, category)
    episode_store.record(
        model,
        category,
        "refusal" if is_refusal else "success",
        latency_ms=lat_ms,
        prompt=prompt,
        err_class=refusal_memory.classify_class(tag) if is_refusal else None,
        tool=tool,
        reason=tag,
    )
    return resp


def generate_stream(
    model: str,
    prompt: str,
    system: str | None = None,
    *,
    temperature: float = 0.3,
    category: str = "",
    tool: str = "repl",
    on_delta,
) -> str:
    """Stream a completion, calling ``on_delta(piece)`` for each text chunk, and
    return the full text. Same size-guard pre-flight, caveman prefix, refusal
    and episode recording as ``generate``. If the provider has no streaming
    method, or the stream dies before emitting anything, it falls back to the
    unary ``generate`` (full fallback-chain robustness) and emits the whole
    answer in one ``on_delta``. A mid-stream failure after partial output is
    re-raised so the caller can surface it."""
    from providers.registry import ModelProviderRegistry
    from providers.router import caveman, episode_store, refusal_memory
    from providers.router.size_guard import check_or_reroute

    if caveman.is_enabled() and category not in ("tools", "mission", "debate"):
        cv = caveman.system_prefix()
        if cv:
            system = (cv + "\n\n" + system) if system else cv

    dispatch_model = model
    ok, hint = check_or_reroute(dispatch_model, prompt)
    if not ok and hint and hint.startswith("route:") and hint != "route:none":
        dispatch_model = hint.split(":", 1)[1]

    prov = ModelProviderRegistry.get_provider_for_model(dispatch_model)
    t0 = time.time()

    def _unary() -> str:
        resp = generate(model, prompt, system, temperature=temperature, category=category, tool=tool)
        txt = getattr(resp, "content", "") or ""
        on_delta(txt)
        return txt

    if prov is None or not hasattr(prov, "generate_content_stream"):
        return _unary()

    buf: list[str] = []
    try:
        for piece in prov.generate_content_stream(
            prompt, dispatch_model, system, temperature=temperature
        ):
            buf.append(piece)
            on_delta(piece)
    except Exception as exc:  # noqa: BLE001
        if buf:
            lat_ms = int((time.time() - t0) * 1000)
            episode_store.record(model, category, "error", latency_ms=lat_ms, prompt=prompt,
                                 err_class=type(exc).__name__, tool=tool, reason=str(exc)[:200])
            raise
        return _unary()  # nothing streamed yet -> robust unary path

    text = "".join(buf)
    lat_ms = int((time.time() - t0) * 1000)
    tag = refusal_memory.classify(text)
    is_refusal = bool(tag and tag.startswith("refusal:"))
    if is_refusal:
        refusal_memory.record(model, category, tag)
    else:
        refusal_memory.record_success(model, category)
    episode_store.record(model, category, "refusal" if is_refusal else "success",
                         latency_ms=lat_ms, prompt=prompt, tool=tool, reason=tag)
    return text
