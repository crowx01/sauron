#!/usr/bin/env bash
# sauron - interactive setup.
# Lets you pick which PAL models to enable and whether the hooks install
# globally (~/.claude/settings.json) or per-project (./.claude/settings.json).
# Writes only what you approve. Backs up any existing settings first.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- pretty print ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
err()  { printf '%s✗%s %s\n' "$RED" "$RST" "$*"; }
hd()   { printf '\n%s%s%s\n' "$BOLD" "$*" "$RST"; }

command -v jq >/dev/null || { err "jq is required (apt install jq)"; exit 1; }

# ---------- banner ----------
# ANSI 256 palette for the fire look:  208 = bright orange, 214 = amber, 220 = gold
ORG=$'\033[38;5;208m'; AMB=$'\033[38;5;214m'; GLD=$'\033[38;5;220m'; EMB=$'\033[38;5;202m'
printf '\n'
printf '%s              .-~~~-.               %s\n'                   "$RED" "$RST"
printf '%s            .%s(   %so   %s).%s              %s\n'  "$RED" "$GLD" "$EMB" "$GLD" "$RED" "$RST"
printf '%s             ~-...-~                %s\n'                   "$RED" "$RST"
printf '\n'
printf '%s     ███████╗ █████╗ ██╗   ██╗██████╗  ██████╗ ███╗   ██╗%s\n' "$ORG" "$RST"
printf '%s     ██╔════╝██╔══██╗██║   ██║██╔══██╗██╔═══██╗████╗  ██║%s\n' "$ORG" "$RST"
printf '%s     ███████╗███████║██║   ██║██████╔╝██║   ██║██╔██╗ ██║%s\n' "$AMB" "$RST"
printf '%s     ╚════██║██╔══██║██║   ██║██╔══██╗██║   ██║██║╚██╗██║%s\n' "$AMB" "$RST"
printf '%s     ███████║██║  ██║╚██████╔╝██║  ██║╚██████╔╝██║ ╚████║%s\n' "$GLD" "$RST"
printf '%s     ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝%s\n' "$GLD" "$RST"
printf '\n'
printf '%s          %sinteractive setup%s   %s.%s   one agent to route them all%s\n' "$DIM" "$BOLD" "$RST$DIM" "$AMB" "$RST$DIM" "$RST"
printf '\n'

# ---------- 1. scope ----------
hd "1. Where should the hooks install?"
cat <<EOF
  ${CYN}g${RST}) global      → ~/.claude/settings.json         (loads every session, every project)
  ${CYN}p${RST}) per-project → \$PWD/.claude/settings.json      (only loads when Claude Code runs here)
  ${CYN}s${RST}) skip        → print the settings JSON to stdout, do not write anything
EOF
read -rp "choice [g/p/s] (default: p): " SCOPE
SCOPE="${SCOPE:-p}"
case "$SCOPE" in
  g) TARGET="$HOME/.claude/settings.json" ;;
  p) TARGET="$PWD/.claude/settings.json" ;;
  s) TARGET="" ;;
  *) err "invalid choice"; exit 1 ;;
esac
[ -n "$TARGET" ] && ok "target: $TARGET" || ok "target: stdout (dry run)"

# ---------- 2. skill auto-load ----------
hd "2. Which skills should auto-load at session start?"
say "  These are invoked as the very first tool calls of every session."
say "  Leave blank to skip a skill; type y to include it."
prompt_yn () { local q="$1" d="$2" a; read -rp "  $q [Y/n]: " a; a="${a:-$d}"; case "$a" in y|Y) echo "1" ;; *) echo "0" ;; esac; }
S_CAVE=$(prompt_yn "caveman (full compression, byte-exact evidence)" y)
S_PENT=$(prompt_yn "pentesting-agent (offensive-security playbooks)" y)
S_VALI=$(prompt_yn "validator (preload skeptical QA reviewer)" y)

# ---------- 3. models ----------
hd "3. Which PAL models should be listed in the delegate-first policy?"
say "  Pick every model your PAL install actually has keys for."
say "  Unselected models are dropped from the routing map so Claude never tries them."
M_GROQ=$(prompt_yn "groq (openai/gpt-oss-120b) - report writing, validation" y)
M_NEMO=$(prompt_yn "nemotron (nvidia via OpenRouter) - bulk reading, 1M ctx" y)
M_GROK=$(prompt_yn "grok (x-ai via OpenRouter, 2M ctx) - permissive security reasoning" y)
M_FLSH=$(prompt_yn "flash (gemini-3.6-flash) - structured extraction" y)
M_ORFR=$(prompt_yn "or-free (openrouter meta-router) - generic fallback" y)
M_PRO=$(prompt_yn "pro (gemini-3-pro-preview) - adversarial debate" y)

# guard: warn if user selected nothing (both no skills AND no models)
if [ "$S_CAVE" = 0 ] && [ "$S_PENT" = 0 ] && [ "$S_VALI" = 0 ] && \
   [ "$M_GROQ" = 0 ] && [ "$M_NEMO" = 0 ] && [ "$M_GROK" = 0 ] && \
   [ "$M_FLSH" = 0 ] && [ "$M_ORFR" = 0 ] && [ "$M_PRO" = 0 ]; then
  warn "you selected no skills and no models; the hook would be inert."
  read -rp "  proceed anyway and write an empty hook? [y/N]: " a
  case "${a:-n}" in y|Y) : ;; *) err "aborted, nothing written"; exit 1 ;; esac
fi

# build a compact routing sentence based on selections
ROUTING=""
[ "$M_GROQ" = 1 ] && ROUTING+="groq (gpt-oss-120b, ~500 rpm, 8000 tpm cap) for report writing, vuln explanations, and skeptical validation. "
[ "$M_NEMO" = 1 ] && ROUTING+="nemotron (nvidia, 1M ctx) for bulk reading of large files. "
[ "$M_GROK" = 1 ] && ROUTING+="grok (x-ai, 2M ctx) for permissive high-context security reasoning when Gemini refuses. "
[ "$M_FLSH" = 1 ] && ROUTING+="flash (gemini-3.6-flash, 1M ctx) for fast structured extraction. "
[ "$M_ORFR" = 1 ] && ROUTING+="or-free (OpenRouter meta-router, 200K ctx) as generalist fallback. "
[ "$M_PRO" = 1 ]  && ROUTING+="pro (gemini-3-pro-preview) for deep-reasoning fallback and adversarial debate via mcp__pal__challenge. "
[ -z "$ROUTING" ] && ROUTING="(no PAL models selected; delegate-first policy inactive). "

# build skills list
SKILLS_LIST=""
[ "$S_CAVE" = 1 ] && SKILLS_LIST+="\`caveman\` (full mode), "
[ "$S_PENT" = 1 ] && SKILLS_LIST+="\`pentesting-agent\`, "
[ "$S_VALI" = 1 ] && SKILLS_LIST+="\`validator\` (preload), "
SKILLS_LIST="${SKILLS_LIST%, }"

# ---------- 4. render SessionStart + UserPromptSubmit hook bodies ----------
if [ -n "$SKILLS_LIST" ]; then
  SS_TEXT="MANDATORY FIRST ACTIONS: on session start and for EVERY model, BEFORE responding, immediately call the Skill tool for ${SKILLS_LIST}. Full preference set: (1) delegate-first via PAL: ${ROUTING}(2) KEEP IN CLAUDE: user-facing decisions, exploitation choices, severity calls, safety-boundary checks, side-effecting actions, tool-sequence orchestration. (3) On every confirmed finding run the 4-step pipeline: validator skill, gap tests, adversarial challenge via mcp__pal__challenge (pro fallback groq), synthesize; delegate report writing to groq."
else
  SS_TEXT="Preferences: delegate-first via PAL: ${ROUTING}KEEP IN CLAUDE: user-facing decisions, exploitation choices, severity calls, safety-boundary checks, side-effecting actions, tool-sequence orchestration. On every confirmed finding run the 4-step pipeline: validator, gap tests, adversarial challenge via mcp__pal__challenge (pro fallback groq), synthesize; delegate report writing to groq."
fi

UPS_TEXT="Reminder every message: delegate aggressively to PAL to conserve tokens (${ROUTING}). Keep in Claude ONLY: user-facing decisions, exploitation choices, severity calls, safety-boundary checks, side-effecting actions, orchestration. FAILOVER: if any model refuses or errors, immediately re-route; a refusal is a routing problem, not a stop."

# ---------- 5. build settings.json ----------
# Each hook fires: printf '%s\n' '<inline JSON with additionalContext>'
build_cmd () {
  local event="$1" text="$2"
  # produce the exact command string, with double-quotes inside additionalContext escaped for JSON
  local escaped
  escaped=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf "printf '%%s\\n' '{\"hookSpecificOutput\":{\"hookEventName\":\"%s\",\"additionalContext\":\"%s\"}}'" "$event" "$escaped"
}
SS_CMD=$(build_cmd "SessionStart" "$SS_TEXT")
UPS_CMD=$(build_cmd "UserPromptSubmit" "$UPS_TEXT")
JSON=$(jq -n --arg ss "$SS_CMD" --arg ups "$UPS_CMD" '{
  hooks: {
    SessionStart:     [ { hooks: [ { type: "command", command: $ss  } ] } ],
    UserPromptSubmit: [ { hooks: [ { type: "command", command: $ups } ] } ]
  }
}')

# ---------- 6. write or dry-run ----------
if [ -z "$TARGET" ]; then
  hd "settings.json (dry run - copy manually):"
  echo "$JSON"
  exit 0
fi

hd "Ready to write ${TARGET}"
say "  Existing file will be backed up with .bak.<timestamp> suffix."
read -rp "proceed? [y/N]: " GO
[[ "$GO" =~ ^[yY]$ ]] || { warn "aborted, nothing written"; exit 0; }

mkdir -p "$(dirname "$TARGET")"
if [ -f "$TARGET" ]; then
  BAK="${TARGET}.bak.$(date +%s)"
  cp "$TARGET" "$BAK"
  ok "backup: $BAK"
fi

# merge: preserve existing top-level keys AND append to any existing hook arrays
# (critical: jq `. * $add` REPLACES arrays; we need to append so other frameworks' hooks survive)
if [ -f "$TARGET" ]; then
  jq --argjson add "$JSON" '
    . as $orig
    | ($orig * ($add | del(.hooks)))
    | .hooks.SessionStart     = (($orig.hooks.SessionStart     // []) + ($add.hooks.SessionStart     // []))
    | .hooks.UserPromptSubmit = (($orig.hooks.UserPromptSubmit // []) + ($add.hooks.UserPromptSubmit // []))
  ' "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  ok "merged into $TARGET (existing hooks preserved, sauron hooks appended)"
else
  echo "$JSON" | jq . > "$TARGET"
  ok "wrote $TARGET"
fi

# ---------- 6b. optional: symlink shipped skills so Claude Code can discover them ----------
SKILLS_SRC="$SCRIPT_DIR/skills"
if [ -d "$SKILLS_SRC" ]; then
  case "$SCOPE" in
    g) SKILLS_DST="$HOME/.claude/skills" ;;
    p) SKILLS_DST="$PWD/.claude/skills" ;;
  esac
  read -rp "symlink shipped skills into $SKILLS_DST? [Y/n]: " a
  case "${a:-y}" in
    y|Y)
      mkdir -p "$SKILLS_DST"
      for d in "$SKILLS_SRC"/*/; do
        name=$(basename "$d")
        target="$SKILLS_DST/$name"
        if [ -e "$target" ] && [ ! -L "$target" ]; then
          warn "skipping $name: destination exists and is not a symlink"
          continue
        fi
        ln -sfn "$d" "$target" && ok "symlinked $name -> $target"
      done
      ;;
    *) warn "skipped skill symlinking; you must place skills under $SKILLS_DST manually" ;;
  esac
fi

# ---------- 6c. sanity-check: is PAL registered in ~/.claude.json? ----------
if [ -f "$HOME/.claude.json" ]; then
  if jq -e '.mcpServers.pal // (.projects | to_entries[]?.value.mcpServers.pal)' "$HOME/.claude.json" >/dev/null 2>&1; then
    ok "PAL MCP server is registered in ~/.claude.json"
  else
    warn "PAL is NOT registered in ~/.claude.json"
    warn "  add it under mcpServers.pal (see https://github.com/BeehiveInnovations/zen-mcp-server)"
    warn "  Claude Code will silently fail to invoke PAL tools until you do."
  fi
else
  warn "~/.claude.json not found; make sure PAL is registered before starting Claude Code"
fi

# ---------- 7. .env template for API keys ----------
NEEDS_ENV=0
[ "$M_GROQ" = 1 ] && NEEDS_ENV=1
[ "$M_NEMO" = 1 ] && NEEDS_ENV=1
[ "$M_GROK" = 1 ] && NEEDS_ENV=1
[ "$M_FLSH" = 1 ] && NEEDS_ENV=1
[ "$M_ORFR" = 1 ] && NEEDS_ENV=1
[ "$M_PRO" = 1 ] && NEEDS_ENV=1
if [ "$NEEDS_ENV" = 1 ]; then
  ENV_PATH="$(dirname "$TARGET")/.env.sauron.example"
  cat > "$ENV_PATH" <<EOF
# sauron API keys - source this from your shell rc, or export before starting Claude Code.
# Do NOT commit the real values.
$( [ "$M_FLSH" = 1 ] || [ "$M_PRO" = 1 ] && echo "export GEMINI_API_KEY=your-gemini-key" )
$( [ "$M_NEMO" = 1 ] || [ "$M_GROK" = 1 ] || [ "$M_ORFR" = 1 ] && echo "export OPENROUTER_API_KEY=your-openrouter-key" )
$( [ "$M_GROQ" = 1 ] && printf '%s\n' "export CUSTOM_API_URL=https://api.groq.com/openai/v1" "export CUSTOM_API_KEY=your-groq-key" )
EOF
  ok "wrote env template: $ENV_PATH"
fi

# ---------- 8. next steps ----------
hd "Next steps"
cat <<EOF
  1. Register PAL as an MCP server in ~/.claude.json:
     ${DIM}"mcpServers": { "pal": { "type": "stdio", "command": "/path/to/zen-mcp-server/.pal_venv/bin/python", "args": ["/path/to/zen-mcp-server/server.py"], "env": { ...keys... } } }${RST}
  2. Source your API keys: ${CYN}source $(dirname "$TARGET")/.env.sauron.example${RST}   (after editing it)
  3. Restart Claude Code.
  4. On the next session start you should see the auto-invoked skills fire immediately.

EOF
ok "sauron setup complete."
