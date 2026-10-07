#!/usr/bin/env bash
# Unit tests for the provider-key helpers in setup-lib.sh (provider_spec,
# provider_field, validate_key). Pure string logic — no prompts, no network.
# Run: bash bin/test-setup-lib.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=bin/setup-lib.sh
. "$DIR/setup-lib.sh"

fail=0
check() { # check <desc> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then printf '  ok  %s\n' "$1"
  else printf '  FAIL %s (expected rc=%s got rc=%s)\n' "$1" "$2" "$3"; fail=1; fi
}
vk() { validate_key "$1" "$2"; echo $?; }

# empty key = skip = valid for every provider
check "empty groq is valid (skip)"        0 "$(vk groq '')"
check "empty gemini is valid (skip)"      0 "$(vk gemini '')"

# well-formed keys pass (synthetic, not real credentials)
check "good groq gsk_"       0 "$(vk groq       'gsk_0123456789ABCDEFghij')"
check "good openrouter sk-or" 0 "$(vk openrouter 'sk-or-v1-0123456789abcdef')"
check "good gemini AIza"     0 "$(vk gemini     'AIzaSyA0123456789012345678901234567')"
check "good openai sk-"      0 "$(vk openai     'sk-proj-0123456789abcdefghij')"
check "good xai xai-"        0 "$(vk xai        'xai-0123456789ABCDEFghij')"

# malformed non-empty keys are rejected (rc=1)
check "groq without prefix rejected"     1 "$(vk groq       'nope-not-a-key')"
check "gemini without AIza rejected"     1 "$(vk gemini     'sk-wrongprovider-123456789012')"
check "openrouter plain sk- rejected"    1 "$(vk openrouter 'sk-plain-openai-style-000000')"

# unknown provider cannot judge -> treated as valid (rc=0), never blocks
check "unknown provider is permissive"   0 "$(vk madeup 'whatever')"

# centralized metadata is present and well-formed
check "groq env var is CUSTOM_API_KEY"   CUSTOM_API_KEY "$(provider_field groq 1)"
check "gemini url is aistudio"           'https://aistudio.google.com/apikey' "$(provider_field gemini 2)"

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"
