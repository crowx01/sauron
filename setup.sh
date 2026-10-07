#!/usr/bin/env bash
# sauron - interactive setup (v2 - multi-select, resume, pentesting-skills sync).
# Writes only what you approve. Backs up any existing settings first.
# Ctrl+C is safe: state is checkpointed at $XDG_STATE_HOME/sauron/install-state
# and a re-run resumes at the first incomplete step.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"

SETUP_BRAND="sauron"
# shellcheck source=bin/setup-lib.sh
. "$BIN_DIR/setup-lib.sh"

command -v jq >/dev/null || { err "jq is required (apt install jq)"; exit 1; }

# ---------- banner (function; only printed for interactive install) ----------
ORG=$'\033[38;5;208m'; AMB=$'\033[38;5;214m'; GLD=$'\033[38;5;220m'; EMB=$'\033[38;5;202m'
print_banner() {
  printf '\n'
  printf '%s                        \\   |   /%s\n'          "$EMB" "$RST"
  printf '%s                     .-~~~~~~~-.%s\n'            "$ORG" "$RST"
  printf '%s                   <  (    %s|%s    )  >%s\n'    "$AMB" "$RED" "$AMB" "$RST"
  printf '%s                     `-~~~~~~~-`%s\n'            "$ORG" "$RST"
  printf '%s                        /   |   \\%s\n'          "$EMB" "$RST"
  printf '\n'
  printf '%s     ███████╗ █████╗ ██╗   ██╗██████╗  ██████╗ ███╗   ██╗%s\n' "$ORG" "$RST"
  printf '%s     ██╔════╝██╔══██╗██║   ██║██╔══██╗██╔═══██╗████╗  ██║%s\n' "$ORG" "$RST"
  printf '%s     ███████╗███████║██║   ██║██████╔╝██║   ██║██╔██╗ ██║%s\n' "$AMB" "$RST"
  printf '%s     ╚════██║██╔══██║██║   ██║██╔══██╗██║   ██║██║╚██╗██║%s\n' "$AMB" "$RST"
  printf '%s     ███████║██║  ██║╚██████╔╝██║  ██║╚██████╔╝██║ ╚████║%s\n' "$GLD" "$RST"
  printf '%s     ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝%s\n' "$GLD" "$RST"
  printf '\n'
  printf '%s          %sinteractive setup%s   %s.%s   one agent to route them all%s\n\n' \
         "$DIM" "$BOLD" "$RST$DIM" "$AMB" "$RST$DIM" "$RST"
}

# ---------- pentesting-skills sync knobs ----------
PENTEST_REPO="${SAURON_PENTESTING_SKILLS_REPO:-https://github.com/crowx01/Pentesting-Skills}"
PENTEST_CACHE="${SAURON_PENTESTING_SKILLS_CACHE:-$HOME/.cache/sauron/pentesting-skills}"

SKILLS_SRC="$SCRIPT_DIR/skills"

# ---------- CLI subcommands ----------
usage() {
  cat <<HLP
${BOLD}sauron setup${RST}

  ./setup.sh                 interactive install (resumes if interrupted)
  ./setup.sh add SKILL       install a single shipped skill into ~/.claude/skills
  ./setup.sh list            list shipped + pentesting-skills
  ./setup.sh sync            re-sync pentesting-skills + shipped skills (no prompts)
  ./setup.sh reset           clear installation checkpoint
  ./setup.sh --help          this help

Environment:
  SAURON_PENTESTING_SKILLS_REPO   default $PENTEST_REPO
  SAURON_PENTESTING_SKILLS_CACHE  default $PENTEST_CACHE
  STATE_DIR                       default \$XDG_STATE_HOME/sauron
HLP
}

# fetch/refresh the pentesting-skills repo into $PENTEST_CACHE (idempotent)
sync_pentesting_repo() {
  ensure_dir "$(dirname "$PENTEST_CACHE")"
  if [ -d "$PENTEST_CACHE/.git" ]; then
    info "refreshing pentesting-skills at $PENTEST_CACHE"
    if ! git -C "$PENTEST_CACHE" pull --ff-only --quiet 2>/dev/null; then
      warn "git pull failed (offline?); using cached copy"
    fi
  else
    info "cloning $PENTEST_REPO → $PENTEST_CACHE"
    if ! git clone --depth 1 --quiet "$PENTEST_REPO" "$PENTEST_CACHE"; then
      err "clone failed; check network or set SAURON_PENTESTING_SKILLS_REPO"
      return 1
    fi
  fi
  ok "pentesting-skills at $PENTEST_CACHE"
}

# install pentesting skills into the agent's skill dir
# $1 = destination root, $2 = "symlink" | "copy"
install_pentesting_skills_into() {
  local dst="$1" mode="${2:-copy}"
  [ -d "$PENTEST_CACHE" ] || { warn "pentesting-skills cache missing; skipping"; return 0; }
  ensure_dir "$dst"
  local count=0 d name
  # accept both root-level and skills/ subdirectory layouts
  local src="$PENTEST_CACHE"
  [ -d "$PENTEST_CACHE/skills" ] && src="$PENTEST_CACHE/skills"
  for d in "$src"/*/; do
    [ -d "$d" ] || continue
    [ -f "$d/SKILL.md" ] || continue
    name=$(basename "$d")
    if [ -e "$dst/$name" ] && [ ! -L "$dst/$name" ] && [ "$mode" = "symlink" ]; then
      warn "  keep $name: $dst/$name exists (not a symlink)"; continue
    fi
    case "$mode" in
      symlink) ln -sfn "$d" "$dst/$name" ;;
      copy)    rm -rf "$dst/$name.tmp"; cp -a "$d" "$dst/$name.tmp"; rm -rf "$dst/$name"; mv "$dst/$name.tmp" "$dst/$name" ;;
    esac
    count=$((count + 1))
  done
  ok "installed $count pentesting-skills → $dst"
}

cmd_list() {
  step "shipped skills"
  local d name desc
  for d in "$SKILLS_SRC"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    desc=""
    [ -f "$d/SKILL.md" ] && desc=$(awk -F': ' '/^description:/ {sub(/^description: */,""); print; exit}' "$d/SKILL.md" | head -c 120)
    printf '  %s%s%s  %s%s%s\n' "$BOLD" "$name" "$RST" "$DIM" "$desc" "$RST"
  done
  if [ -d "$PENTEST_CACHE" ]; then
    step "pentesting-skills ($PENTEST_CACHE)"
    local src="$PENTEST_CACHE"
    [ -d "$PENTEST_CACHE/skills" ] && src="$PENTEST_CACHE/skills"
    for d in "$src"/*/; do
      [ -d "$d" ] || continue
      [ -f "$d/SKILL.md" ] || continue
      name=$(basename "$d")
      desc=$(awk -F': ' '/^description:/ {sub(/^description: */,""); print; exit}' "$d/SKILL.md" | head -c 120)
      printf '  %s%s%s  %s%s%s\n' "$BOLD" "$name" "$RST" "$DIM" "$desc" "$RST"
    done
  else
    info "run  ./setup.sh sync  to fetch pentesting-skills"
  fi
}

cmd_add() {
  local skill="${1:-}"
  [ -z "$skill" ] && { err "usage: ./setup.sh add <skill>"; cmd_list; exit 2; }
  local src=""
  [ -d "$SKILLS_SRC/$skill" ] && src="$SKILLS_SRC/$skill"
  if [ -z "$src" ] && [ -d "$PENTEST_CACHE" ]; then
    local p="$PENTEST_CACHE"; [ -d "$PENTEST_CACHE/skills" ] && p="$PENTEST_CACHE/skills"
    [ -d "$p/$skill" ] && src="$p/$skill"
  fi
  if [ -z "$src" ]; then
    err "unknown skill: $skill"; cmd_list; exit 2
  fi
  local dst="${SAURON_DEST:-$HOME/.claude/skills}"
  ensure_dir "$dst"
  if [ -e "$dst/$skill" ] && [ ! -L "$dst/$skill" ]; then
    warn "$dst/$skill exists (not a symlink); leaving in place"
  else
    ln -sfn "$src" "$dst/$skill"
    ok "linked $skill → $dst/$skill"
  fi
}

cmd_sync() {
  sync_pentesting_repo
  ensure_dir "$HOME/.claude/skills"
  local d
  for d in "$SKILLS_SRC"/*/; do
    [ -d "$d" ] || continue
    ln -sfn "$d" "$HOME/.claude/skills/$(basename "$d")"
  done
  install_pentesting_skills_into "$HOME/.claude/skills" symlink
  ok "sync complete"
}

case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
  add)   shift; cmd_add "$@"; exit $? ;;
  list)  cmd_list; exit 0 ;;
  sync)  cmd_sync; exit 0 ;;
  reset) state_clear; ok "checkpoint cleared"; exit 0 ;;
esac

print_banner

# ---------- checkpoint bootstrap ----------
state_init
STEPS=(
  "orch|Orchestrator selection"
  "scope|Install scope"
  "skills_pick|Skill preload picks"
  "models_pick|PAL model picks"
  "write_target|Rules/settings file"
  "claude_md|CLAUDE.md doctrine"
  "skills_install|Shipped skills installed"
  "pentest_sync|pentesting-skills synchronised"
  "pal_register|PAL MCP registered"
  "env_keys|API keys"
)
resume_banner "${STEPS[@]}"

# ---------- 0. orchestrator ----------
if state_done orch && [ -n "$(state_get orch_val)" ]; then
  ORCH=$(state_get orch_val); ok "orchestrator (cached): $ORCH"
else
  step "0. Which agent orchestrator do you use?"
  ORCH_LABELS=(
    "claude-code  (default)          hooks + Skill() + delegate policy"
    "cursor                          writes .cursor/rules/*.mdc (alwaysApply)"
    "cline                           writes .clinerules"
    "codex-cli    (OpenAI)           writes ~/.codex/instructions.md"
    "aider                           writes .aider.*.md + conf entry"
    "generic / other                 writes SYSTEM_PROMPT.md (portable)"
  )
  ORCH_KEYS=(c r l x a g)
  menu_select ORCH_IDX 0 "${ORCH_LABELS[@]}"
  ORCH="${ORCH_KEYS[$ORCH_IDX]}"
  state_set orch_val "$ORCH"; state_mark orch
  ok "orchestrator: $ORCH"
fi

# ---------- 1. scope ----------
if state_done scope && [ -n "$(state_get scope_val)" ]; then
  SCOPE=$(state_get scope_val); ok "scope (cached): $SCOPE"
else
  step "1. Where should it install?"
  SCOPE_LABELS=(
    "global      → ~/.claude/settings.json         (every session, every project)"
    "per-project → \$PWD/.claude/settings.json      (only in this project)"
    "skip        → dry run, print JSON, write nothing"
  )
  SCOPE_KEYS=(g p s)
  menu_select SCOPE_IDX 1 "${SCOPE_LABELS[@]}"
  SCOPE="${SCOPE_KEYS[$SCOPE_IDX]}"
  state_set scope_val "$SCOPE"; state_mark scope
  ok "scope: $SCOPE"
fi

# ---------- 2. skills ----------
if state_done skills_pick && [ -n "$(state_get skills_val)" ]; then
  SKILL_FLAGS=$(state_get skills_val); ok "skills (cached): $SKILL_FLAGS"
else
  step "2. Which skills should auto-load at session start?"
  say "  Space toggles · Enter confirms · a=all · n=none"
  SKILL_LABELS=(
    "caveman            full compression, byte-exact evidence"
    "pentesting-agent   offensive-security playbooks"
    "validator          preload skeptical QA reviewer"
  )
  multiselect SKILL_FLAGS "1,1,1" "${SKILL_LABELS[@]}"
  state_set skills_val "$SKILL_FLAGS"; state_mark skills_pick
fi
read -r -a _SF <<< "$SKILL_FLAGS"
S_CAVE=${_SF[0]:-0}; S_PENT=${_SF[1]:-0}; S_VALI=${_SF[2]:-0}

# ---------- 3. models ----------
if state_done models_pick && [ -n "$(state_get models_val)" ]; then
  MODEL_FLAGS=$(state_get models_val); ok "models (cached): $MODEL_FLAGS"
else
  step "3. Which PAL models do you have keys for?"
  MODEL_LABELS=(
    "groq       gpt-oss-120b     report writing, validation (+ qwen3 tool executor, same Groq key)"
    "nemotron   nvidia (OR)      bulk reading, 1M ctx"
    "grok       x-ai (OR)        permissive security reasoning, 1M ctx (paid)"
    "flash      gemini-3.6       structured extraction"
    "or-free    OR meta-router   generalist fallback"
    "pro        gemini-3.1-pro   adversarial debate"
  )
  multiselect MODEL_FLAGS "1,1,1,1,1,1" "${MODEL_LABELS[@]}"
  state_set models_val "$MODEL_FLAGS"; state_mark models_pick
fi
read -r -a _MF <<< "$MODEL_FLAGS"
M_GROQ=${_MF[0]:-0}; M_NEMO=${_MF[1]:-0}; M_GROK=${_MF[2]:-0}
M_FLSH=${_MF[3]:-0}; M_ORFR=${_MF[4]:-0}; M_PRO=${_MF[5]:-0}

if [ "$S_CAVE$S_PENT$S_VALI" = "000" ] && [ "$M_GROQ$M_NEMO$M_GROK$M_FLSH$M_ORFR$M_PRO" = "000000" ]; then
  warn "you selected no skills and no models; the hook would be inert."
  read -rp "  proceed anyway? [y/N]: " a
  [[ "${a:-n}" =~ ^[yY]$ ]] || { err "aborted"; exit 1; }
fi

# ---------- routing sentence ----------
ROUTING=""
[ "$M_GROQ" = 1 ] && { ROUTING+="groq (gpt-oss-120b, ~500 rpm, 8000 tpm cap) for report writing, vuln explanations, and skeptical validation; qwen3 (qwen/qwen3.8-27b via Groq) is the default tool executor for \`pal run\` and /tools (gpt-oss trips Groq's output parser on tool prompts). Delegate whole jobs with \`pal run --plan <file>\` (or \`--agent\` for heavy coding/tool work). "; }
[ "$M_NEMO" = 1 ] && ROUTING+="nemotron (nvidia, 1M ctx) for bulk reading of large files. "
[ "$M_GROK" = 1 ] && ROUTING+="grok (x-ai/grok-4.3, 1M ctx) for permissive high-context security reasoning when Gemini refuses. "
[ "$M_FLSH" = 1 ] && ROUTING+="flash (gemini-3.6-flash, 1M ctx) for fast structured extraction. "
[ "$M_ORFR" = 1 ] && ROUTING+="or-free (OpenRouter meta-router, 200K ctx) as generalist fallback. "
[ "$M_PRO" = 1 ]  && ROUTING+="pro (gemini-3.1-pro-preview) for deep-reasoning fallback and adversarial debate via mcp__pal__challenge. "
[ -z "$ROUTING" ] && ROUTING="(no PAL models selected; delegate-first policy inactive). "

SKILLS_LIST=""
[ "$S_CAVE" = 1 ] && SKILLS_LIST+="\`caveman\` (full mode), "
[ "$S_PENT" = 1 ] && SKILLS_LIST+="\`pentesting-agent\`, "
[ "$S_VALI" = 1 ] && SKILLS_LIST+="\`validator\` (preload), "
SKILLS_LIST="${SKILLS_LIST%, }"

if [ -n "$SKILLS_LIST" ]; then
  SS_TEXT="Doctrine + routing map are in CLAUDE.md at the project root (already loaded). Preload skills now: ${SKILLS_LIST}."
else
  SS_TEXT="Doctrine + routing map are in CLAUDE.md at the project root (already loaded)."
fi
UPS_TEXT="Every message: Claude PLANS and decides only — it does NOT execute. Route ALL execution to the PAL engine (bulk read/extract to nemotron/flash, write/validate to groq, tool loops/recon/scans/edits to the tool-capable model pool, per CLAUDE.md routing); pre-filter recon output locally first ($BIN_DIR/sauron-normalize, $BIN_DIR/strip-noise). Keep ONLY planning, decisions, severity/safety judgments and side-effect approval in Claude to save tokens; everything else runs on engine models. Failover on refusal, never stop."

# ---------- 4. render settings.json ----------
build_cmd () {
  local event="$1" text="$2" escaped
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

# ---------- 5. dry-run branch ----------
if [ "$SCOPE" = "s" ]; then
  step "config (dry run - copy manually):"
  case "$ORCH" in
    c) echo "$JSON" ;;
    *) printf '# SessionStart-equivalent\n%s\n\n# UserPromptSubmit-equivalent\n%s\n' "$SS_TEXT" "$UPS_TEXT" ;;
  esac
  exit 0
fi

# ---------- 6. resolve TARGET ----------
case "$ORCH" in
  c) case "$SCOPE" in g) TARGET="$HOME/.claude/settings.json" ;; p) TARGET="$PWD/.claude/settings.json" ;; esac ;;
  r) case "$SCOPE" in g) TARGET="$HOME/.cursor/rules/sauron.mdc" ;; p) TARGET="$PWD/.cursor/rules/sauron.mdc" ;; esac ;;
  l) case "$SCOPE" in g) TARGET="$HOME/.clinerules" ;; p) TARGET="$PWD/.clinerules" ;; esac ;;
  x) TARGET="$HOME/.codex/instructions.md" ;;
  a) case "$SCOPE" in g) TARGET="$HOME/.aider.sauron.md" ;; p) TARGET="$PWD/.aider.sauron.md" ;; esac ;;
  g) case "$SCOPE" in g) TARGET="$HOME/SYSTEM_PROMPT.sauron.md" ;; p) TARGET="$PWD/SYSTEM_PROMPT.sauron.md" ;; esac ;;
esac

step "Ready to write $TARGET"
say "  Existing file will be backed up with .bak.<timestamp> suffix."
say "  Skills (shipped + pentesting-skills) will be installed automatically."
if [ -z "${SAURON_YES:-}" ]; then
  read -rp "  proceed? [Y/n]: " GO
  [[ "${GO:-y}" =~ ^[nN]$ ]] && { warn "aborted"; exit 0; }
fi

# ---------- 7. write target ----------
write_target() {
  ensure_dir "$(dirname "$TARGET")"
  backup_once "$TARGET"
  case "$ORCH" in
    c)
      if [ -f "$TARGET" ]; then
        jq --argjson add "$JSON" '
          def dedupe(cur; added):
            (cur // []) as $c
            | (added // []) as $a
            | $c + ($a | map(select(. as $new | $c | map(.hooks[0].command // "") | index($new.hooks[0].command // "") | not)));
          . as $orig
          | ($orig * ($add | del(.hooks)))
          | .hooks.SessionStart     = dedupe($orig.hooks.SessionStart;     $add.hooks.SessionStart)
          | .hooks.UserPromptSubmit = dedupe($orig.hooks.UserPromptSubmit; $add.hooks.UserPromptSubmit)
        ' "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
      else
        echo "$JSON" | jq . > "$TARGET"
      fi ;;
    r) cat > "$TARGET" <<MDC
---
description: sauron framework - delegate-first + failover doctrine
alwaysApply: true
---

# sauron rules

## Session context
$SS_TEXT

## Every-message reminder
$UPS_TEXT
MDC
      ;;
    l) printf '# sauron rules for Cline\n\n## Doctrine\n%s\n\n## On every message\n%s\n' "$SS_TEXT" "$UPS_TEXT" > "$TARGET" ;;
    x) printf '# sauron instructions for Codex CLI\n\n%s\n\n---\n%s\n' "$SS_TEXT" "$UPS_TEXT" > "$TARGET" ;;
    a) printf '# sauron conventions for Aider\n\n%s\n\n%s\n' "$SS_TEXT" "$UPS_TEXT" > "$TARGET" ;;
    g) printf '# sauron SYSTEM PROMPT (portable)\n\n%s\n\n---\n%s\n' "$SS_TEXT" "$UPS_TEXT" > "$TARGET" ;;
  esac
  ok "wrote $TARGET"
}
checkpoint write_target "write $TARGET" write_target

# ---------- 8. CLAUDE.md doctrine ----------
case "$SCOPE" in g) CLAUDE_MD="$HOME/CLAUDE.md" ;; p) CLAUDE_MD="$PWD/CLAUDE.md" ;; esac
write_claude_md() {
  [ -n "$CLAUDE_MD" ] || return 0
  backup_once "$CLAUDE_MD"
  local SIBLING_PRESENT=0
  [ -f "$CLAUDE_MD" ] && grep -q '<!-- BEGIN let-there-be-light doctrine' "$CLAUDE_MD" && SIBLING_PRESENT=1
  local DOC_BLOCK
  if [ "$SIBLING_PRESENT" = 1 ]; then
    DOC_BLOCK=$(cat <<CLAUDEMD

<!-- BEGIN sauron doctrine (managed by setup.sh; sibling: let-there-be-light) -->
# sauron doctrine (lean; shared rules provided by sibling block)

Sibling framework \`let-there-be-light\` supplies: delegate-first routing, keep-in-Claude list, failover doctrine, token-efficiency rules, response terseness ladder, preempt-shell-bloat rules, failure-map, and route-plan pre-flight.

## 4-step validation pipeline (sauron variant: per confirmed finding, before report)
A. Stress-test via validator skill.
B. Run gap tests, negative controls, and live observations.
C. Adversarial challenge via mcp__pal__challenge (pro primary, groq fallback).
D. Synthesize with confidence markers; groq drafts the report, Claude spot-checks.

## Preloaded skills
${SKILLS_LIST:-(none preloaded; all skills lazy-load on trigger phrase)}
<!-- END sauron doctrine -->
CLAUDEMD
)
  else
    DOC_BLOCK=$(cat <<CLAUDEMD

<!-- BEGIN sauron doctrine (managed by setup.sh; regenerate to update) -->
# sauron doctrine

## Delegate-first routing
${ROUTING}

## Keep in Claude ONLY
- user-facing decisions
- exploitation choices, severity calls
- safety-boundary checks (no 3rd-party data, no destructive actions, no account creation)
- side-effecting actions
- tool-sequence orchestration

## Failover
Any model refusal or error routes to the next model in the map.

## 4-step validation pipeline
A. Stress-test via validator skill.
B. Run the gap tests, negative controls, and live observations.
C. Adversarial challenge via mcp__pal__challenge (pro primary, groq fallback).
D. Synthesize with confidence markers; groq drafts the report, Claude spot-checks.

## Token efficiency rules
- Recon tool output → $BIN_DIR/sauron-normalize + $BIN_DIR/strip-noise before context.
- Any tool output over 5 KB routes through nemotron (bulk) or flash (structured).
- Batch related PAL sub-tasks into one structured call.

## Preloaded skills
${SKILLS_LIST:-(none preloaded; all skills lazy-load on trigger phrase)}
<!-- END sauron doctrine -->
CLAUDEMD
)
  fi
  if [ -f "$CLAUDE_MD" ]; then
    awk 'BEGIN{skip=0}
      /^<!-- BEGIN sauron doctrine/{skip=1; next}
      /^<!-- END sauron doctrine/{skip=0; next}
      skip==0{print}' "$CLAUDE_MD" > "${CLAUDE_MD}.tmp" && mv "${CLAUDE_MD}.tmp" "$CLAUDE_MD"
  fi
  printf '%s\n' "$DOC_BLOCK" >> "$CLAUDE_MD"
  ok "wrote CLAUDE.md doctrine: $CLAUDE_MD"
}
checkpoint claude_md "install CLAUDE.md doctrine" write_claude_md

# ---------- 9. install shipped skills (auto) ----------
install_skills() {
  [ -d "$SKILLS_SRC" ] || return 0
  local dst
  case "$ORCH" in
    c)
      case "$SCOPE" in g) dst="$HOME/.claude/skills" ;; p) dst="$PWD/.claude/skills" ;; esac
      ensure_dir "$dst"
      local d name
      for d in "$SKILLS_SRC"/*/; do
        [ -d "$d" ] || continue
        name=$(basename "$d")
        if [ -e "$dst/$name" ] && [ ! -L "$dst/$name" ]; then
          warn "skipping $name: $dst/$name exists (not a symlink)"; continue
        fi
        ln -sfn "$d" "$dst/$name"
      done
      ok "linked shipped skills → $dst" ;;
    r)
      local root; case "$SCOPE" in g) root="$HOME" ;; p) root="$PWD" ;; esac
      ensure_dir "$root/skills-cursor" "$root/rules"
      sync_dir "$SKILLS_SRC" "$root/skills-cursor"
      cp -f "$TARGET" "$root/rules/sauron.mdc" 2>/dev/null || true
      ok "installed skills → $root/skills-cursor  rules → $root/rules" ;;
    *)
      local mirror="$(dirname "$TARGET")/sauron-skills"
      sync_dir "$SKILLS_SRC" "$mirror"
      ok "installed skills → $mirror"
      if ! grep -q '^## Skills available' "$TARGET" 2>/dev/null; then
        {
          echo
          echo "## Skills available (read these when their trigger phrases appear)"
          for d in "$mirror"/*/; do
            n=$(basename "$d")
            echo "- \`$n\`: see [$n/SKILL.md](sauron-skills/$n/SKILL.md)"
          done
        } >> "$TARGET"
      fi ;;
  esac
}
checkpoint skills_install "install shipped skills" install_skills

# ---------- 10. sync pentesting-skills ----------
do_pentest_sync() {
  command -v git >/dev/null 2>&1 || { err "git not found; cannot sync pentesting-skills"; return 1; }
  sync_pentesting_repo || return 1
  local dst
  case "$ORCH" in
    c)
      case "$SCOPE" in g) dst="$HOME/.claude/skills" ;; p) dst="$PWD/.claude/skills" ;; esac
      install_pentesting_skills_into "$dst" symlink ;;
    r)
      local root; case "$SCOPE" in g) root="$HOME" ;; p) root="$PWD" ;; esac
      install_pentesting_skills_into "$root/skills-cursor" copy ;;
    *)
      local mirror="$(dirname "$TARGET")/sauron-skills"
      install_pentesting_skills_into "$mirror" copy ;;
  esac
}
checkpoint pentest_sync "sync pentesting-skills" do_pentest_sync

# ---------- 11. Sauron core engine (bundled PAL) MCP register ----------
# The PAL engine now ships INSIDE sauron at ./core — one install, no separate
# download. Registered under the mcpServers key "pal" for internal/back-compat.
CORE_DIR="$SCRIPT_DIR/core"
CORE_VENV="$CORE_DIR/.sauron_venv"
PAL_DIR="${PAL_DIR:-$CORE_DIR}"          # bundled core; override only for dev checkouts
PAL_REPO="https://github.com/crowx01/sauron"
register_pal() {
  [ "$ORCH" = "c" ] || { warn "non-Claude orchestrator: start the engine yourself with 'sauron serve'"; return 0; }

  # Always ensure the agentic toolbelt config exists (fresh installs AND upgrades).
  # bash is further limited to a read-only command allowlist baked into pal itself.
  if [ ! -f "$HOME/.pal/toolbelt.json" ]; then
    mkdir -p "$HOME/.pal"
    cat > "$HOME/.pal/toolbelt.json" <<'TBJSON'
{
  "tools": [
    {"name": "bash",      "enabled": true,  "sandbox": "readonly"},
    {"name": "read_file", "enabled": true,  "sandbox": "readonly"},
    {"name": "gh",        "enabled": true,  "sandbox": "readonly"},
    {"name": "web_fetch", "enabled": true,  "sandbox": "readonly"},
    {"name": "clink",     "enabled": false, "sandbox": "readonly"}
  ]
}
TBJSON
    ok "wrote default toolbelt config → ~/.pal/toolbelt.json"
  fi

  [ -f "$HOME/.claude.json" ] || echo '{}' > "$HOME/.claude.json"
  command -v python3 >/dev/null 2>&1 || { err "python3 not found"; return 1; }
  local tmp cfg="$HOME/.claude.json"

  # Resolve which core to register. Prefer the BUNDLED ./core. Only if it is
  # genuinely absent (partial dev checkout) keep an existing external core, else
  # clone. This is also the MIGRATION: an old install whose .mcpServers.pal still
  # points at ~/tools/pal-mcp-server gets repointed to the bundled core below.
  local core="$CORE_DIR"
  if [ ! -f "$core/server.py" ]; then
    local prev; prev="$(jq -r '.mcpServers.pal.args[0] // empty' "$cfg" 2>/dev/null || true)"
    if [ -n "$prev" ] && [ -f "$prev" ]; then
      core="$(dirname "$prev")"                       # reuse the existing external core
    else
      command -v git >/dev/null 2>&1 || { err "bundled core/ missing and git not found"; return 1; }
      core="$PAL_DIR"
      if [ ! -f "$core/server.py" ]; then
        info "bundled core/ missing; cloning $PAL_REPO → $core"
        [ -d "$core/.git" ] || git clone --depth 1 "$PAL_REPO" "$core" || return 1
        [ -f "$core/server.py" ] || core="$core/core"
      fi
    fi
  fi

  # Pick the venv: prefer a .sauron_venv; adopt a legacy .pal_venv if that is
  # what already exists next to the core.
  local venv="$core/.sauron_venv"
  if [ ! -x "$venv/bin/python" ] && [ -x "$core/.pal_venv/bin/python" ]; then
    venv="$core/.pal_venv"
  fi

  # Fast path: already registered, pointing at THIS core, venv ready, toolbelt on.
  if [ -x "$venv/bin/python" ] \
     && [ "$(jq -r '.mcpServers.pal.args[0] // empty' "$cfg" 2>/dev/null || true)" = "$core/server.py" ] \
     && jq -e '.mcpServers.pal.env.PAL_TOOLBELT' "$cfg" >/dev/null 2>&1; then
    ok "Sauron core engine already registered (core=$core, toolbelt on)"
    return 0
  fi

  # Provision venv (idempotent) then (RE)WRITE the registration. One jq both
  # installs fresh AND migrates an old external registration to this core, while
  # PRESERVING any user-added env keys (e.g. API keys) via env-merge.
  if [ ! -x "$venv/bin/python" ]; then
    venv="$core/.sauron_venv"
    python3 -m venv "$venv"
  fi
  "$venv/bin/python" -m pip install -q -r "$core/requirements.txt"
  tmp="$(mktemp)"
  # PAL_TOOLBELT=1 turns on the agentic tool-loop; smart-router features
  # (self-heal, cache, classifier, refusal-memory, health-probe) default on in-code.
  jq --arg cmd "$venv/bin/python" --arg srv "$core/server.py" '
    .mcpServers = (.mcpServers // {})
    | .mcpServers.pal = {
        type: "stdio",
        command: $cmd,
        args: [$srv],
        env: ((.mcpServers.pal.env // {}) + {
          DEFAULT_MODEL: ((.mcpServers.pal.env.DEFAULT_MODEL) // "auto"),
          PAL_TOOLBELT: "1"
        })
      }' "$cfg" > "$tmp" && mv "$tmp" "$cfg"
  ok "Sauron core engine registered (core=$core, DEFAULT_MODEL=auto, toolbelt on)"
}
checkpoint pal_register "PAL MCP registration" register_pal

# ---------- 11b. sanity-check: do the auto-loaded skills actually exist? ----------
# A hook that orders Skill(x) for a skill that is not installed makes every session start
# with a failing tool call, and nothing in the error says which skill or where to get it.
if [ "$ORCH" = "c" ]; then
  SKILL_DIRS="$HOME/.claude/skills"
  [ "$SCOPE" = "p" ] && SKILL_DIRS="$PWD/.claude/skills $SKILL_DIRS"
  skill_present () {
    local name="$1" d
    # shellcheck disable=SC2086 -- SKILL_DIRS is a deliberate space-separated list
    for d in $SKILL_DIRS; do [ -e "$d/$name/SKILL.md" ] && return 0; done
    return 1
  }
  for pair in "$S_CAVE:caveman" "$S_PENT:pentesting-agent" "$S_VALI:validator"; do
    sel="${pair%%:*}"; name="${pair#*:}"
    [ "$sel" = 1 ] || continue
    if skill_present "$name"; then
      ok "skill present: $name"
    else
      warn "skill NOT found: $name (looked in: $SKILL_DIRS)"
      [ "$name" = caveman ] && warn "  get it from https://github.com/JuliusBrussee/caveman"
      case "$name" in pentesting-agent|validator)
        warn "  get it from https://github.com/Darxbloo/Pentesting-Agent-new" ;;
      esac
      warn "  every session will open with a failing Skill($name) call until you install it."
    fi
  done
fi

# ---------- 12. API keys ----------


NEEDS_ENV=0
M_OPENAI=0
for f in "$M_GROQ" "$M_NEMO" "$M_GROK" "$M_FLSH" "$M_ORFR" "$M_PRO"; do
  [ "$f" = 1 ] && NEEDS_ENV=1
done

ENV_REAL=""; ENV_EXAMPLE=""
if [ "$NEEDS_ENV" = 1 ]; then
  read -rp "  Also configure an OpenAI key (optional, for gpt-5 tiers)? [y/N]: " _oa
  [[ "${_oa:-n}" =~ ^[yY]$ ]] && M_OPENAI=1
  ENV_EXAMPLE="$(dirname "$TARGET")/.env.sauron.example"
  ENV_REAL="$(dirname "$TARGET")/.env.sauron"
  cat > "$ENV_EXAMPLE" <<EOF
# sauron API keys - source before starting your orchestrator.
$( [ "$M_FLSH" = 1 ] || [ "$M_PRO" = 1 ] && echo "export GEMINI_API_KEY=your-gemini-key" )
$( [ "$M_NEMO" = 1 ] || [ "$M_GROK" = 1 ] || [ "$M_ORFR" = 1 ] && echo "export OPENROUTER_API_KEY=your-openrouter-key" )
$( [ "$M_GROQ" = 1 ] && printf '%s\n' "export CUSTOM_API_URL=https://api.groq.com/openai/v1" "export CUSTOM_API_KEY=your-groq-key" )
$( [ "$M_OPENAI" = 1 ] && echo "export OPENAI_API_KEY=your-openai-key" )
EOF
  ok "wrote env template: $ENV_EXAMPLE"
fi

collect_keys() {
  [ "$NEEDS_ENV" = 1 ] || return 0
  step "API keys"
  say "  Enter each key now (visible as asterisks) or press ENTER to skip."
  local GROQ_KEY="" OR_KEY="" GEMINI_KEY="" OPENAI_KEY=""
  # provider metadata (URL/env-var/shape) + masked entry + shape validation all
  # live in setup-lib.sh read_key, so the installer stays free of scattered URLs.
  [ "$M_GROQ" = 1 ] && read_key GROQ_KEY groq
  { [ "$M_NEMO" = 1 ] || [ "$M_GROK" = 1 ] || [ "$M_ORFR" = 1 ]; } && read_key OR_KEY openrouter
  { [ "$M_FLSH" = 1 ] || [ "$M_PRO" = 1 ]; } && read_key GEMINI_KEY gemini
  [ "$M_OPENAI" = 1 ] && read_key OPENAI_KEY openai
  local umask_prev; umask_prev=$(umask); umask 077
  {
    [ "$M_FLSH" = 1 ] || [ "$M_PRO" = 1 ] && printf 'export GEMINI_API_KEY=%s\n' "${GEMINI_KEY:-your-gemini-key}"
    [ "$M_NEMO" = 1 ] || [ "$M_GROK" = 1 ] || [ "$M_ORFR" = 1 ] && printf 'export OPENROUTER_API_KEY=%s\n' "${OR_KEY:-your-openrouter-key}"
    if [ "$M_GROQ" = 1 ]; then
      printf 'export CUSTOM_API_URL=https://api.groq.com/openai/v1\n'
      printf 'export CUSTOM_API_KEY=%s\n' "${GROQ_KEY:-your-groq-key}"
    fi
    [ "$M_OPENAI" = 1 ] && printf 'export OPENAI_API_KEY=%s\n' "${OPENAI_KEY:-your-openai-key}"
  } > "$ENV_REAL"
  chmod 600 "$ENV_REAL"
  umask "$umask_prev"
  ok "wrote $ENV_REAL (0600)"
}
checkpoint env_keys "API keys" collect_keys

# ---------- 13. next steps ----------
step "Next steps"
case "$ORCH" in
  c) cat <<EOF
  1. Source your API keys:  source $(dirname "$TARGET")/.env.sauron
  2. Restart Claude Code (the bundled core engine auto-starts as the 'pal' MCP server).
  3. Session-start skills auto-load on the next session.
  4. Talk to the engine directly any time:  sauron chat      (interactive router)
     or start it standalone / for other clients:  sauron serve
  5. Add more pentesting skills any time:  npx --yes github:crowx01/sauron add <skill>
                                          (or  ./setup.sh add <skill>)
  6. Refresh pentesting-skills:  npx --yes github:crowx01/sauron sync
EOF
  ;;
  *) cat <<EOF
  1. Source your API keys:  source $(dirname "$TARGET")/.env.sauron
  2. Open your project in your orchestrator.
  3. Add more skills any time:  npx --yes github:crowx01/sauron add <skill>
EOF
  ;;
esac
echo
ok "sauron setup complete."
info "checkpoint at $STATE_FILE (delete with:  ./setup.sh reset)"
