"""HuggingFace router provider (OpenAI-compatible).

Surfaces HuggingFace's inference router (https://router.huggingface.co/v1)
through the standard OpenAI-compatible path, so org/model ids such as
``meta-llama/Llama-3.1-8B-Instruct`` or ``deepseek-ai/DeepSeek-V4.1-Flash``
are routable like any other provider. Capabilities are generic (org/model
format), mirroring the OpenRouter fallback.

The ``org`` segment is treated as the authority: an id like
``openai/gpt-5.1-codex-mini`` *looks* like org/model but is in fact an
OpenRouter-style id meant for another provider. If HuggingFace claims it,
the HF router returns 400 (no such model there) and the whole call fails
before OpenRouter -- next in the priority order -- ever gets a chance.
``_FOREIGN_ORGS`` below is the explicit blocklist of first-segments that
HuggingFace must defer on, so those ids reach OpenRouter / native providers
instead of exploding at the HF edge.
"""

import logging

from .openai_compatible import OpenAICompatibleProvider
from .shared import ModelCapabilities, ProviderType, RangeTemperatureConstraint

# OpenRouter-style first-segments (plus native-provider aliases) that must
# NOT be claimed by the HF generic matcher. Lowercase. Extend when a new
# provider shows up in the OR catalog with a conflicting ``org/model`` id.
_FOREIGN_ORGS = frozenset(
    {
        "openai",
        "anthropic",
        "google",
        "x-ai",
        "xai",
        "cohere",
        "mistralai",
        "mistral",
        "perplexity",
        "perplexityai",
        "inflection",
        "databricks",
        "01-ai",
        "moonshot",
        "moonshotai",
        "ai21",
        "allenai",
        "baai",
        "nvidia",
        "fireworks",
        "fireworks-ai",
        "together",
        "together-ai",
        "groq",
        "openrouter",
        "aws",
        "azure",
        "amazon",
        "amazonaws",
        "openchat",
    }
)


class HuggingFaceProvider(OpenAICompatibleProvider):
    FRIENDLY_NAME = "HuggingFace"

    def __init__(self, api_key: str, **kwargs):
        super().__init__(api_key, base_url="https://router.huggingface.co/v1", **kwargs)

    def get_provider_type(self) -> ProviderType:
        return ProviderType.HUGGINGFACE

    def _lookup_capabilities(self, canonical_name: str, requested_name: str | None = None):
        # Only claim ids that look like HuggingFace org/model (no ":" tag).
        if "/" not in canonical_name or ":" in canonical_name:
            logging.debug("HuggingFace: rejecting non org/model id '%s'", canonical_name)
            return None
        org = canonical_name.split("/", 1)[0].lower()
        if org in _FOREIGN_ORGS:
            logging.debug(
                "HuggingFace: deferring '%s' to another provider "
                "(org '%s' is on the foreign-provider blocklist; typically "
                "routed via OpenRouter or a native provider)",
                canonical_name,
                org,
            )
            return None
        cap = ModelCapabilities(
            provider=ProviderType.HUGGINGFACE,
            model_name=canonical_name,
            friendly_name=self.FRIENDLY_NAME,
            intelligence_score=9,
            context_window=32_768,
            max_output_tokens=8_192,
            supports_extended_thinking=False,
            supports_system_prompts=True,
            supports_streaming=True,
            supports_function_calling=True,
            temperature_constraint=RangeTemperatureConstraint(0.0, 2.0, 1.0),
        )
        cap._is_generic = True
        return cap
