---
name: kali-exec
description: >-
  Deterministic Kali/Linux shell-execution doctrine for the sauron framework.
  Fixes the recurring class of failures where "cd ~/Desktop then run X" splits
  across independent shell invocations, where tilde or $HOME expands wrong,
  where PEP 668 blocks a global pip install, and where the orchestrator reaches
  for `apt install` or `pip install` before checking whether the capability is
  already present. Triggers on any Bash tool call that runs on a Kali or
  Debian/Ubuntu host, any `chmod/ls/cat/cd` against a user-home path, any
  `pip install`, `apt install`, `python3 -m pip`, `which`, `command -v`,
  `pipx install`, `uv pip`, `poetry add`, `conda install`, or any shell line
  that opens with `cd` or that depends on a prior `cd` to resolve.
---

# kali-exec

**One-line pitch:** the Kali/Linux execution doctrine every tool call must
obey — no implicit cwd, no `--break-system-packages`, no reinstall of a tool
that is already on `$PATH`.

## Core invariant: every command carries its own cwd

Each Bash tool call starts a **new shell process**. A prior `cd` in another
Bash call does **not** carry over. Relying on that is the root cause of
failures like:

```text
Call 1:  cd ~/Desktop
Call 2:  chmod +x convert_excel_to_json.sh
         chmod: cannot access 'convert_excel_to_json.sh': No such file or directory
```

Call 2 ran in `$HOME`, not `~/Desktop`.

### Rules

1. **Always pass an absolute path**, resolved up front. Never emit a relative
   path that depends on a previous `cd`. Resolve `~` and `$HOME` yourself,
   not via a separate `echo ~` call.
2. **Combine `cd` with its work in one line** when a cwd is unavoidable:
   `( cd /home/kali/Desktop && chmod +x convert_excel_to_json.sh )` — the
   subshell keeps your main shell state unchanged *and* survives a single
   tool call.
3. **Never emit a `cd` as its own tool call** expecting state to persist.
4. **Normalize before you execute**. Transform model-produced paths through
   this ladder before they reach the shell:
   - Strip surrounding whitespace / quotes.
   - Expand leading `~` or `~user` to the user's home.
   - Expand `$HOME`, `$USER`, `$XDG_*` from the current environment.
   - `realpath -m` the result (if the path need not yet exist) or
     `realpath -e` (if it must exist).
   - Reject any path containing `\n`, NUL, or control chars.
5. **Use `$HOME` (or `getent passwd`) over `/home/<name>`.** The Kali default
   user is `kali` on common images but `root` on the live-ISO; hardcoding
   `/home/kali` works until it doesn't.
6. **Quote every path** that could contain spaces or shell metacharacters:
   `chmod +x "$script"`, not `chmod +x $script`.
7. **Verify before you act.** Before `chmod`, `rm`, `mv`, or `cp`, `ls -la --`
   the target and confirm it exists. If it doesn't, do **not** silently
   create it — report the mismatch upstream so recovery can decide whether
   the file was written by a previous step that actually failed.

### Approved patterns

```bash
# Resolve once at the orchestrator layer, then pass absolute paths down.
script="$HOME/Desktop/convert_excel_to_json.sh"
test -f "$script" || { echo "missing: $script" >&2; exit 2; }
chmod +x -- "$script"

# One-liner subshell when a cwd really is needed.
( cd -- "$HOME/Desktop" && python3 ./convert_excel_to_json.sh ASSETS_ALL.xlsx )

# Capture both streams and exit code so the recovery skill can classify.
set -o pipefail
out=$( { python3 -- "$script" "$input"; } 2>&1 ); rc=$?
```

### Forbidden patterns

```bash
cd ~/Desktop                                    # state does not persist across tool calls
chmod +x convert_excel_to_json.sh               # resolves against cwd of a different shell
pip install openpyxl                            # see PEP 668 section below
pip install --break-system-packages openpyxl    # last resort, never default
sudo rm -rf "$dir/*"                            # bare glob + sudo + rm is a landmine
eval "$model_output"                            # never eval model-generated shell
```

## PEP 668 (externally-managed-environment) decision tree

Kali ships Python under PEP 668, so `pip install X` on the system interpreter
emits:

```text
error: externally-managed-environment
× This environment is externally managed
```

**Do not reach for `--break-system-packages`.** That poisons the system
interpreter and silently breaks apt-managed Python packages on the next
upgrade. Follow this decision tree instead:

```text
need package P
│
├── already importable?  →  python3 -c "import P" 2>/dev/null  → use it, stop here
│
├── distro package exists?  →  apt-cache search '^python3-P$'
│       └── yes → sudo apt-get install -y python3-P  (preferred; survives apt upgrades)
│
├── one-off CLI tool (binary entry-point, not a library we import)?
│       └── pipx install P   (isolated venv per tool, PATH-exposed)
│
├── project workflow (we are inside or own a project dir)?
│       └── create / reuse  <project>/.venv  :
│           python3 -m venv .venv
│           . .venv/bin/activate
│           python3 -m pip install -U pip P
│           → every subsequent call MUST use .venv/bin/python
│
├── ad-hoc scratch (we neither own a project nor want a system install)?
│       └── create  $XDG_DATA_HOME/sauron/venvs/<task-id>/
│                   /bin/python  and reuse it for this task
│
└── last resort, explicit user approval:
        python3 -m pip install --break-system-packages --user P
```

### Rules

1. **Capability check comes first.** `python3 -c "import openpyxl"` costs a
   millisecond and tells the truth. Do that before every install path.
2. **One venv per task, path is deterministic.** For an ad-hoc venv prefer
   `${XDG_DATA_HOME:-$HOME/.local/share}/sauron/venvs/<slug>/`. Record the
   venv's `python` path in task state so subsequent calls reuse it rather
   than hitting PEP 668 again on the next iteration.
3. **Never silently fall back** from an isolated venv to a system install.
   Report the failure upward so recovery can decide (not a retry).
4. **Prefer apt-shipped `python3-*`** for well-known libraries
   (`python3-openpyxl`, `python3-requests`, `python3-pandas`,
   `python3-numpy`, `python3-paramiko`, `python3-impacket`). They are
   batteries-included on Kali and survive upgrades.
5. **`--break-system-packages` is a load-bearing commitment.** Only emit it
   when: (a) the user explicitly asked for a system-wide install, or
   (b) the recovery chain classified every other option as impossible
   *and* logged the reason.

### Already-installed cache (per run)

Once a package / binary has been verified present in this run, record it in
the orchestrator's context as `kali-exec.have[<name>] = <path>` and
**do not re-probe or re-install it**. A repeated "module not found" after a
successful install means the orchestrator used the wrong interpreter, not
that the package is missing again — route that specific error class to
`recovery` instead of looping on pip.

## Capability-first orchestration

Before any `install`, `clone`, `download`, or new tool creation, run the
capability check:

1. **Binary already on PATH?**   `command -v <tool>`
2. **Already in /usr/{bin,sbin,share}, /opt, or `$HOME/go/bin`?**
   `ls /usr/bin/<tool> /opt/<tool>/bin/<tool>`
3. **Python module importable?**  `python3 -c 'import <mod>' 2>&1`
4. **Node/npm global binary?**    `command -v <tool>` + `npm root -g`
5. **PAL toolbelt entry already exposes it?** Check `~/.pal/toolbelt.json`.
6. **Shipped sauron / pentesting-skills script covers it?** See
   `~/.claude/skills/*/scripts/` and `bin/` entries documented in each
   `SKILL.md`.
7. **Kali meta-package already pulled it?**
   `dpkg -L kali-tools-top10 | grep -i <tool>` (the common attacker
   toolchain is pre-installed on a Kali default image: nmap, nikto, hydra,
   gobuster, dirb, wfuzz, sqlmap, metasploit, burp*, wireshark, …).

**Rule:** if any of these returns a usable path, **use that path** and stop.
Do not emit an `apt install`, `pip install`, or `git clone` for a capability
that already exists. Reinstalling a present tool is a bug class, not a
recovery strategy.

## Structured command result

Every Kali tool invocation this skill produces (or wraps) must surface a
structured result to the orchestrator. Minimum schema:

```json
{
  "command": "python3 /home/kali/Desktop/convert.py ASSETS_ALL.xlsx",
  "cwd":     "/home/kali/Desktop",
  "exit":    1,
  "stdout_tail": "...",
  "stderr_tail": "ModuleNotFoundError: No module named 'openpyxl'",
  "duration_ms": 142,
  "env": { "PYTHONPATH": "", "VIRTUAL_ENV": "" },
  "error_class": "missing_python_dep",
  "evidence": { "interpreter": "/usr/bin/python3", "pep668": true }
}
```

`error_class` is one of (see also the `recovery` skill):

- `transient`                    (network blip, 503, retryable)
- `missing_file`                 (ENOENT on a path we expected)
- `missing_binary`               (command not found)
- `missing_python_dep`           (ModuleNotFoundError)
- `pep668_blocked`               (externally-managed-environment)
- `wrong_cwd`                    (file exists at absolute path but relative lookup failed)
- `permission_denied`            (EACCES, EPERM)
- `invalid_argument`             (usage error, non-zero exit with help text)
- `timeout`                      (we killed the process)
- `oom`                          (killed by signal 9 and dmesg confirms)
- `model_refusal`                (not a shell outcome, but recovery handles both)
- `model_hallucinated_tool`      (tool_name not in PAL toolbelt)
- `unknown`

The orchestrator passes `error_class` to the `recovery` skill, which decides
the next model and the next action.

## Working-directory tests the orchestrator should mentally run

Before emitting a path-sensitive command, walk through:

- Is this an **absolute** path?  If no, make it one.
- Does `~` or `$HOME` appear anywhere?  If yes, expand it in the current
  tool-call text so a sibling shell can't disagree.
- Does the next tool call in the plan depend on the cwd this one is in?
  If yes, use a subshell or re-emit the full absolute path.
- Could the path contain a space, newline, or metacharacter?  If yes,
  quote it and prefer `--` to separate options from paths.

## Anti-patterns

- Emitting `cd` as its own tool call and expecting the next call to inherit.
- Expanding `~` by `echo ~` into a variable instead of using `$HOME`.
- Pattern-matching `No such file or directory` and re-emitting the same
  command. Always classify first, then route to `recovery`.
- Treating `externally-managed-environment` as a transient and retrying
  the same `pip install`.
- `pip install --break-system-packages` as a default; it is a last resort,
  only after `recovery` has escalated and the user approved.
- `apt install <foo>` without `apt-cache show <foo>` first; wrong-name
  installs on Kali waste minutes and cache.
- `sudo` on anything the user has not already approved for the run.

## The rule

> Resolve paths once, verify before you act, check capabilities before you
> install, classify every failure before you retry.
