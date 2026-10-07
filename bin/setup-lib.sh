#!/usr/bin/env bash
# setup-lib.sh - shared interactive-installer primitives (multi-select, masked
# input, checkpoint/resume, logging).  Duplicated verbatim between lttbl and
# sauron; SETUP_LIB_VERSION below tracks drift.
SETUP_LIB_VERSION="1.0.0"

# ---------- colors / logging ----------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YLW=$'\033[33m'; CYN=$'\033[36m'; MAG=$'\033[35m'; RST=$'\033[0m'
: "${SETUP_BRAND:=setup}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YLW" "$RST" "$*"; }
err()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$*" >&2; }
info() { printf '  %s›%s %s\n' "$CYN" "$RST" "$*"; }
step() { printf '\n%s%s╺╸%s %s%s%s\n' "$BOLD" "$CYN" "$RST" "$BOLD" "$*" "$RST"; }
hd()   { step "$@"; }
rule() { printf '%s%s%s\n' "$DIM" "────────────────────────────────────────────────────────────────" "$RST"; }
banner_tag() { printf '%s[%s]%s %s\n' "$DIM" "$SETUP_BRAND" "$RST" "$*"; }

# ---------- checkpoint state ----------
# STATE_DIR resolves to $XDG_STATE_HOME/<brand>/install (or ~/.local/state/...)
# STATE_FILE is a flat "step=status" text file, one line per step.
: "${STATE_DIR:=${XDG_STATE_HOME:-$HOME/.local/state}/$SETUP_BRAND}"
: "${STATE_FILE:=$STATE_DIR/install-state}"

state_init() {
  mkdir -p "$STATE_DIR"
  [ -f "$STATE_FILE" ] || : > "$STATE_FILE"
}
state_get() { # $1=key -> prints value or empty
  awk -F= -v k="$1" '$1==k {print $2; exit}' "$STATE_FILE" 2>/dev/null || true
}
state_set() { # $1=key $2=value  (atomic replace)
  local k="$1" v="$2" tmp
  state_init
  tmp="$(mktemp "${STATE_FILE}.XXXX")"
  awk -F= -v k="$k" '$1!=k' "$STATE_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}
state_done() { [ "$(state_get "$1")" = "ok" ]; }
state_mark() { state_set "$1" "ok"; }
state_clear() { state_init; : > "$STATE_FILE"; }

# checkpoint <step_id> <human_label> <cmd...>
#   Skips if step already ok; on success marks ok.
#   Any failure leaves the step unmarked so a resume retries it.
checkpoint() {
  local id="$1" label="$2"; shift 2
  if state_done "$id"; then
    ok "$label  ${DIM}(cached)${RST}"
    return 0
  fi
  info "$label"
  if "$@"; then
    state_mark "$id"
    return 0
  else
    local rc=$?
    err "step '$id' failed (rc=$rc); rerun installer to resume"
    return "$rc"
  fi
}

resume_banner() { # prints "previous installation detected" if any step is ok
  state_init
  [ -s "$STATE_FILE" ] || return 0
  local total done_n
  total=$(printf '%s\n' "$@" | wc -l)
  done_n=$(awk -F= '$2=="ok"' "$STATE_FILE" 2>/dev/null | wc -l)
  [ "$done_n" -gt 0 ] || return 0
  step "Previous installation detected"
  local id label
  while IFS='|' read -r id label; do
    [ -z "$id" ] && continue
    if state_done "$id"; then
      printf '  %s✓%s %s\n' "$GRN" "$RST" "$label"
    else
      printf '  %s○%s %s\n' "$DIM" "$RST" "$label"
    fi
  done <<< "$(printf '%s\n' "$@")"
  info "Resuming installation…"
}

# ---------- Ctrl+C handling ----------
# The point is that Ctrl+C terminates cleanly WITHOUT corrupting state.
# state_set is atomic (mktemp + mv) so a signal during a step just leaves that
# step unmarked, which is exactly what we want for resume.
# Central cleanup — restore stty/cursor/wrap even if SIGINT hits mid-read.
_LIB_OLD_STTY=""
_lib_cleanup() {
  printf '%s' $'\033[?25h\033[?7h' 2>/dev/null || true
  [ -n "$_LIB_OLD_STTY" ] && stty "$_LIB_OLD_STTY" 2>/dev/null || true
  _LIB_OLD_STTY=""
}
_lib_on_int() {
  _lib_cleanup
  printf '\n'
  warn "interrupted — state saved at $STATE_FILE. rerun the installer to resume."
  exit 130
}
trap _lib_cleanup EXIT
trap _lib_on_int INT TERM

# ---------- masked API-key input ----------
# Reads a secret with each keystroke echoed as an asterisk (visible count, hidden
# value).  Falls back to `read -rs` when stdin is not a tty.
# Usage: masked_read VAR "prompt: "
masked_read() {
  local __var="$1" __prompt="$2" __buf="" __ch __rest
  if [ ! -t 0 ]; then
    IFS= read -r __buf
    printf -v "$__var" '%s' "$__buf"
    return 0
  fi
  printf '%s' "$__prompt"
  local __old_stty; __old_stty=$(stty -g 2>/dev/null || true)
  stty -echo -icanon min 1 time 0 2>/dev/null || true
  while IFS= read -rsn1 __ch; do
    case "$__ch" in
      $'\n'|$'\r'|"") break ;;
      $'\x7f'|$'\b')  # backspace / DEL
        if [ -n "$__buf" ]; then
          __buf="${__buf%?}"
          printf '\b \b'
        fi ;;
      $'\x03') # Ctrl+C
        [ -n "$__old_stty" ] && stty "$__old_stty"
        printf '\n'; _lib_on_int ;;
      $'\x1b') # swallow escape sequences (arrows etc.)
        read -rsn2 __rest || true ;;
      *)
        __buf+="$__ch"
        printf '*' ;;
    esac
  done
  [ -n "$__old_stty" ] && stty "$__old_stty"
  printf '\n'
  printf -v "$__var" '%s' "$__buf"
}

# ---------- provider key metadata (single source of truth) ----------
# One row per provider the engine can authenticate. provider_spec <id> prints
# four TAB-separated fields so the installer never scatters URLs/env-vars/shapes:
#   <env_var> <console_url> <key_regex> <description>
# key_regex is a loose shape check (warn-not-block); an empty regex means
# "cannot validate shape". Keep this in sync with core catalog `_auth()`.
provider_spec() {
  case "$1" in
    groq)       printf '%s\t%s\t%s\t%s\n' CUSTOM_API_KEY     'https://console.groq.com/keys'         '^gsk_[A-Za-z0-9]{20,}$'        'Groq (groq/gpt-oss + qwen3 default tool executor)' ;;
    openrouter) printf '%s\t%s\t%s\t%s\n' OPENROUTER_API_KEY 'https://openrouter.ai/settings/keys'   '^sk-or-[A-Za-z0-9._-]{10,}$'   'OpenRouter (nemotron / grok / openrouter-free)' ;;
    gemini)     printf '%s\t%s\t%s\t%s\n' GEMINI_API_KEY     'https://aistudio.google.com/apikey'    '^AIza[A-Za-z0-9_-]{30,}$'      'Google Gemini (flash / pro)' ;;
    openai)     printf '%s\t%s\t%s\t%s\n' OPENAI_API_KEY     'https://platform.openai.com/api-keys'  '^sk-[A-Za-z0-9._-]{20,}$'      'OpenAI (optional, gpt-5 tiers)' ;;
    xai)        printf '%s\t%s\t%s\t%s\n' XAI_API_KEY        'https://console.x.ai'                  '^xai-[A-Za-z0-9]{20,}$'        'xAI (native Grok models)' ;;
    *) return 1 ;;
  esac
}

# field <id> <1-based column> -> that TAB field of provider_spec, or "".
provider_field() { provider_spec "$1" 2>/dev/null | cut -f"$2"; }

# validate_key <provider_id> <key> -> 0 when the key is EMPTY (a skip) or
# matches the provider's expected shape; 1 when it is non-empty but malformed.
# Warn-not-block: callers surface 1 as a warning but may still keep the value,
# because provider key formats change over time.
validate_key() {
  local __id="$1" __key="$2" __regex
  [ -z "$__key" ] && return 0
  __regex="$(provider_field "$__id" 3)"
  [ -z "$__regex" ] && return 0            # no shape known -> cannot judge
  printf '%s' "$__key" | grep -Eq "$__regex"
}

# read_key <VAR> <provider_id>
# Masked prompt for a provider key, with the provider's description + official
# console URL shown first, loose shape validation, and a single re-entry on an
# obviously-malformed value. ENTER skips (left blank). Never echoes the key.
read_key() {
  local __var="$1" __id="$2" __url __desc __val __tries=0
  __url="$(provider_field "$__id" 2)"
  __desc="$(provider_field "$__id" 4)"
  [ -n "$__desc" ] && info "$__desc — get a key at $__url"
  while :; do
    masked_read "$__var" "    ${__id} API Key (ENTER to skip): "
    printf -v "$__var" '%s' "$(printf '%s' "${!__var}" | tr -d '[:space:]')"
    __val="${!__var}"
    [ -z "$__val" ] && { warn "skipped ${__id} — add it to the env file later to enable it"; return 0; }
    validate_key "$__id" "$__val" && return 0
    __tries=$((__tries + 1))
    if [ "$__tries" -ge 2 ]; then
      warn "keeping the ${__id} value as entered — validate manually if authentication fails."
      return 0
    fi
    warn "that does not look like a ${__id} key (expected shape per $__url). Re-enter, or ENTER to skip."
  done
}

# ---------- multi-select ----------
# multiselect  RESULT_ARRAY_NAME  DEFAULTS_CSV  LABEL_1 LABEL_2 ...
#   DEFAULTS_CSV: comma-separated 0/1 (one per label) for initial selection.
#   Assigns space-separated 0/1 flags into RESULT_ARRAY_NAME.
# Controls: ↑/↓ or k/j move, space toggles, a=all, n=none, enter confirms, q=cancel.
multiselect() {
  local __out="$1" __defaults="$2"; shift 2
  local __labels=("$@")
  local __n=${#__labels[@]}
  local __sel=() __i __key __rest __cur=0
  IFS=',' read -ra __defaults_arr <<< "$__defaults"
  for ((__i=0; __i<__n; __i++)); do
    __sel[__i]="${__defaults_arr[__i]:-0}"
  done

  # non-tty fallback: honor defaults and return
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    printf -v "$__out" '%s' "${__sel[*]}"
    return 0
  fi

  _LIB_OLD_STTY=$(stty -g 2>/dev/null || true)
  local __old_stty="$_LIB_OLD_STTY"
  stty -echo -icanon min 1 time 0 2>/dev/null || true
  # flush any stale keystrokes before entering the loop
  while IFS= read -rsn1 -t 0.001 __junk 2>/dev/null; do :; done
  printf '%s' $'\033[?25l\033[?7l'   # hide cursor, disable line-wrap

  _ms_render() {
    local i mark row
    for ((i=0; i<__n; i++)); do
      [ "${__sel[i]}" = "1" ] && mark="${GRN}◉${RST}" || mark="${DIM}○${RST}"
      if [ "$i" = "$__cur" ]; then
        row="${BOLD}${CYN}❯${RST} $mark  ${BOLD}${__labels[i]}${RST}"
      else
        row="  $mark  ${DIM}${__labels[i]}${RST}"
      fi
      printf '%s\n' "$row"
    done
    printf '\n  %s↑/↓%s navigate  %sspace%s toggle  %sa%s all  %sn%s none  %senter%s confirm\n' \
      "$BOLD" "$RST" "$BOLD" "$RST" "$BOLD" "$RST" "$BOLD" "$RST" "$BOLD" "$RST"
  }

  _ms_render
  while :; do
    IFS= read -rsn1 __key || break
    case "$__key" in
      $'\x1b')
        read -rsn2 -t 0.1 __rest || true
        case "$__rest" in
          '[A'|'OA') ((__cur > 0)) && ((__cur--)) ;;
          '[B'|'OB') ((__cur < __n-1)) && ((__cur++)) ;;
        esac ;;
      k) ((__cur > 0)) && ((__cur--)) ;;
      j) ((__cur < __n-1)) && ((__cur++)) ;;
      ' ') __sel[__cur]=$([ "${__sel[__cur]}" = "1" ] && echo 0 || echo 1) ;;
      a|A) for ((__i=0; __i<__n; __i++)); do __sel[__i]=1; done ;;
      n|N) for ((__i=0; __i<__n; __i++)); do __sel[__i]=0; done ;;
      $'\n'|$'\r'|"") break ;;
      $'\x03') _lib_on_int ;; # Ctrl+C -> EXIT trap restores stty/cursor
      q|Q) _lib_cleanup; err "multi-select cancelled"; return 1 ;;
    esac
    # redraw: cursor up n+2, clear to end of screen
    printf '\033[%dA\033[J' "$((__n+2))"
    _ms_render
  done
  _lib_cleanup
  printf -v "$__out" '%s' "${__sel[*]}"
}

# ---------- single-choice menu (arrow-key select of one option) ----------
# menu_select RESULT_VAR DEFAULT_INDEX  LABEL_1 LABEL_2 ...
menu_select() {
  local __out="$1" __cur="$2"; shift 2
  local __labels=("$@") __n=${#__labels[@]} __key __rest

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    printf -v "$__out" '%s' "$__cur"
    return 0
  fi
  _LIB_OLD_STTY=$(stty -g 2>/dev/null || true)
  stty -echo -icanon min 1 time 0 2>/dev/null || true
  while IFS= read -rsn1 -t 0.001 __junk 2>/dev/null; do :; done
  printf '%s' $'\033[?25l\033[?7l'

  _ss_render() {
    local i row
    for ((i=0; i<__n; i++)); do
      if [ "$i" = "$__cur" ]; then
        row="${BOLD}${CYN}❯${RST} ${BOLD}${__labels[i]}${RST}"
      else
        row="  ${DIM}${__labels[i]}${RST}"
      fi
      printf '%s\n' "$row"
    done
    printf '\n  %s↑/↓%s navigate  %senter%s confirm\n' "$BOLD" "$RST" "$BOLD" "$RST"
  }
  _ss_render
  while :; do
    IFS= read -rsn1 __key || break
    case "$__key" in
      $'\x1b') read -rsn2 -t 0.1 __rest || true
        case "$__rest" in
          '[A'|'OA') ((__cur > 0)) && ((__cur--)) ;;
          '[B'|'OB') ((__cur < __n-1)) && ((__cur++)) ;;
        esac ;;
      k) ((__cur > 0)) && ((__cur--)) ;;
      j) ((__cur < __n-1)) && ((__cur++)) ;;
      $'\n'|$'\r'|"") break ;;
      $'\x03') _lib_on_int ;;
    esac
    printf '\033[%dA\033[J' "$((__n+2))"
    _ss_render
  done
  _lib_cleanup
  printf -v "$__out" '%s' "$__cur"
}

# ---------- idempotent file ops ----------
# ensure_dir <path>
ensure_dir() { [ -d "$1" ] || mkdir -p "$1"; }

# sync_dir SRC DST  (rsync-style, no delete; preserves user-added siblings)
sync_dir() {
  local src="$1" dst="$2"
  ensure_dir "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --update "$src"/ "$dst"/
  else
    cp -aun "$src"/. "$dst"/ 2>/dev/null || cp -a "$src"/. "$dst"/
  fi
}

# backup_once <path>  (writes .bak.<epoch> only if the destination exists AND
# has not been backed up in this run — tracked in a per-run associative array).
declare -A _BACKED_UP=() 2>/dev/null || true
backup_once() {
  local p="$1"
  [ -f "$p" ] || return 0
  [ -n "${_BACKED_UP[$p]:-}" ] && return 0
  local bak="${p}.bak.$(date +%s)"
  cp "$p" "$bak"
  _BACKED_UP[$p]=1
  ok "backed up $p → $(basename "$bak")"
}
