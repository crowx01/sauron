#!/usr/bin/env node
// sauron CLI - unified entry point.
//   * installer / skill verbs (install, add, list, sync, reset) -> setup.sh
//   * engine verbs (serve, chat, run, mission, diag, distill, models, debate)
//     -> the bundled Python core at ./core (formerly the PAL MCP server)
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup.sh');
const CORE_DIR = path.join(ROOT, 'core');
const CORE_VENV_PY = path.join(CORE_DIR, '.sauron_venv', 'bin', 'python');
const CORE_CLI = path.join(CORE_DIR, 'cli.py');

const BOLD='\x1b[1m', DIM='\x1b[2m', RED='\x1b[31m', RST='\x1b[0m';

// engine subcommands handled by the bundled Python core (./core/cli.py)
const CORE_CMDS = new Set(['serve', 'chat', 'run', 'mission', 'diag', 'distill', 'models', 'debate']);

function usage() {
  console.log(`${BOLD}sauron${RST}  one agent to route them all — offensive-security AI orchestrator

${BOLD}Run the engine${RST}
  sauron serve            start the core engine (MCP server) for any client
  sauron chat             interactive chat: auto cheap/smart routing, /debate, /delegate
  sauron run "<task>"     headless one-shot task (add --plan <file> for a plan)
  sauron mission "<goal>" adaptive writer→executor→judge pipeline
  sauron diag [--json]    router + learning-state dump
  sauron models | distill | debate   (args forwarded to the engine)

${BOLD}Install & skills${RST} (github: form works without npm publish)
  npx --yes github:crowx01/sauron                install (interactive; resumes on Ctrl+C)
  npx --yes github:crowx01/sauron add <skill>    install one shipped or pentesting skill
  npx --yes github:crowx01/sauron list           list shipped + pentesting-skills
  npx --yes github:crowx01/sauron sync           re-sync pentesting-skills + shipped
  npx --yes github:crowx01/sauron reset          clear checkpoint
  npx --yes github:crowx01/sauron selftest       validate shipped files (no network)
  sauron --help                                  this help

${DIM}From a local clone: ./setup.sh <install-verb>   ·   node bin/cli.js <verb>${RST}

Environment:
  SAURON_PENTESTING_SKILLS_REPO   default https://github.com/crowx01/Pentesting-Skills
  SAURON_PENTESTING_SKILLS_CACHE  default ~/.cache/sauron/pentesting-skills
`);
}

function runSetup(args) {
  if (!fs.existsSync(SETUP)) {
    console.error(`${RED}✗${RST} setup.sh missing in ${ROOT}`);
    process.exit(1);
  }
  const r = spawnSync('bash', [SETUP, ...args], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

// Dispatch an engine verb into the bundled Python core.
function runCore(sub, args) {
  if (!fs.existsSync(CORE_CLI)) {
    console.error(`${RED}✗${RST} bundled core missing at ${CORE_DIR} (reinstall sauron)`);
    process.exit(1);
  }
  if (!fs.existsSync(CORE_VENV_PY)) {
    console.error(`${RED}✗${RST} core engine not provisioned yet. Run the installer first:`);
    console.error(`    npx --yes github:crowx01/sauron        ${DIM}(or ./setup.sh)${RST}`);
    process.exit(1);
  }
  // Run with cwd=core so server.py / providers imports resolve on sys.path[0].
  const r = spawnSync(CORE_VENV_PY, [CORE_CLI, sub, ...args], { stdio: 'inherit', cwd: CORE_DIR });
  process.exit(r.status == null ? 1 : r.status);
}

const [,, cmd, ...rest] = process.argv;

if (cmd && CORE_CMDS.has(cmd)) {
  runCore(cmd, rest);
}

switch (cmd) {
  case undefined:
  case 'install':
    runSetup([]);
    break;
  case '-h':
  case '--help':
  case 'help':
    usage();
    break;
  case 'list':
    runSetup(['list']);
    break;
  case 'add':
    if (!rest[0]) {
      console.error(`${RED}✗${RST} usage: npx --yes github:crowx01/sauron add <skill>`);
      runSetup(['list']);
      process.exit(2);
    }
    runSetup(['add', rest[0]]);
    break;
  case 'sync':
    runSetup(['sync']);
    break;
  case 'reset':
    runSetup(['reset']);
    break;
  case 'selftest': {
    const script = path.join(ROOT, 'bin', 'sauron-selftest');
    if (!fs.existsSync(script)) {
      console.error(`${RED}✗${RST} bin/sauron-selftest missing in ${ROOT}`);
      process.exit(1);
    }
    const r = spawnSync('bash', [script], { stdio: 'inherit' });
    process.exit(r.status == null ? 1 : r.status);
  }
  default:
    console.error(`${RED}✗${RST} unknown command: ${cmd}`);
    usage();
    process.exit(2);
}
