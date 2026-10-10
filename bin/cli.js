#!/usr/bin/env node
// sauron CLI - unified entry point (TypeScript/Bun Rebuilt Engine).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup.sh');
const TS_CLI = path.join(ROOT, 'src', 'cli.ts');

const BOLD = '\x1b[1m', DIM = '\x1b[2m', RED = '\x1b[31m', RST = '\x1b[0m';

const CORE_CMDS = new Set(['serve', 'chat', 'run', 'mission', 'diag', 'distill', 'models', 'debate', 'sessions']);

function findBun() {
  const userBun = path.join(process.env.HOME || '', '.bun', 'bin', 'bun');
  if (fs.existsSync(userBun)) return userBun;
  return 'bun';
}

function usage() {
  console.log(`${BOLD}sauron${RST}  one agent to route them all — offensive-security AI orchestrator (v2.0 OpenCode Rebuild)

${BOLD}Run the engine${RST}
  sauron chat             start the OpenCode-inspired interactive TUI
  sauron run "<task>"     headless one-shot task
  sauron mission "<goal>" adaptive writer→executor→judge pipeline
  sauron diag             router + diagnostics dump
  sauron models | distill | debate

${BOLD}Install & skills${RST}
  sauron add <skill>      install pentesting skill
  sauron list             list available skills
  sauron sync             sync pentesting skills
  sauron selftest         validate shipped files
  sauron --help           this help
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

function runEngine(sub, args) {
  const bunBin = findBun();
  const r = spawnSync(bunBin, ['run', TS_CLI, sub, ...args], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status == null ? 1 : r.status);
}

const [,, cmd, ...rest] = process.argv;

if (cmd && CORE_CMDS.has(cmd)) {
  runEngine(cmd, rest);
}

switch (cmd) {
  case undefined:
  case 'chat':
    runEngine('chat', []);
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
      console.error(`${RED}✗${RST} usage: sauron add <skill>`);
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
