import { openCodeTUIEngine } from './tui';
import { chatRouter } from './router';
import { sessionStore } from './session';
import { toolBelt } from './tools';
import { missionRunner } from './mission';
import { debateEngine } from './agent/debate';
import { lessonStore } from './router/lessons';
import { configManager } from './config';

// Signal handlers for clean CLI exit codes
process.on('SIGINT', () => {
  process.exit(130);
});

process.on('SIGTERM', () => {
  process.exit(143);
});

function requireText(args: string[], usage: string): string {
  const text = args.join(' ').trim();
  if (!text) {
    console.error(`Error: missing required argument.\n${usage}`);
    process.exit(1);
  }
  return text;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'chat';

  switch (cmd) {
    case 'chat':
      await openCodeTUIEngine.start();
      break;

    case 'run': {
      const prompt = requireText(args.slice(1), 'Usage: sauron run "<task>"');
      console.log(`Running headless task: "${prompt}"`);
      sessionStore.addMessage('user', prompt);
      const messages = sessionStore.getActiveSession().messages;
      for await (const chunk of chatRouter.dispatch(messages)) {
        if (chunk.delta) process.stdout.write(chunk.delta);
      }
      console.log('\n');
      break;
    }

    case 'mission': {
      const goal = requireText(args.slice(1), 'Usage: sauron mission "<goal>"');
      console.log(`Starting mission pipeline for: "${goal}"`);
      const report = await missionRunner.executeMission(goal);
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case 'diag':
      console.log('--- SAURON DIAGNOSTICS & LEARNING STATE ---');
      console.log(`Node/Bun version: ${process.version}`);
      console.log(`Config:`, configManager.getConfig());
      console.log(`Catalog models:`, chatRouter.getCatalog().length);
      console.log(`Available tools:`, toolBelt.listTools().map((t) => t.name));
      console.log(`Sessions count:`, sessionStore.listSessions().length);
      console.log(`Lesson stats:`, lessonStore.getStats());
      break;

    case 'models':
      console.log('--- SAURON MODEL CATALOG ---');
      for (const entry of chatRouter.getCatalog()) {
        console.log(`Model: ${entry.model.padEnd(30)} Provider: ${entry.provider.padEnd(12)} Intelligence: ${entry.intelligence}`);
      }
      break;

    case 'sessions':
      console.log('--- SAVED SESSIONS ---');
      for (const s of sessionStore.listSessions()) {
        console.log(`[${s.id}] ${s.title} (${s.messageCount} msgs)`);
      }
      break;

    case 'debate': {
      const question = requireText(args.slice(1), 'Usage: sauron debate "<question>"');
      console.log(`Running Multi-Model Debate on: "${question}"...`);
      const result = await debateEngine.runDebate(question);
      console.log('\n--- MODEL PERSPECTIVES ---');
      for (const p of result.perspectives) {
        console.log(`\n[${p.model} (${p.provider})]:`);
        console.log(p.response || `Error: ${p.error}`);
      }
      console.log('\n--- CONSENSUS SYNTHESIS ---');
      console.log(result.consensus);
      console.log('\n--- KEY DISSENT ---');
      console.log(result.dissent);
      break;
    }

    case 'distill': {
      console.log('--- SAURON ROUTING INTELLIGENCE & LESSON DISTILLATION ---');
      const stats = lessonStore.getStats();
      console.log('Distilled Model Outcomes:', JSON.stringify(stats, null, 2));
      break;
    }

    case 'add':
    case 'list':
    case 'sync':
    case 'reset':
    case 'selftest':
      console.log(`Skill management command: sauron ${cmd}`);
      break;

    default:
      console.log(`
SAURON v2.0 (OpenCode TUI Rebuild)

Usage:
  sauron chat             Start OpenCode terminal interactive UI
  sauron run "<task>"     Execute headless one-shot task
  sauron mission "<goal>" Adaptive writer->executor->judge pipeline
  sauron diag             Diagnostics and learning status
  sauron models           Display model capabilities & routing catalog
  sauron sessions         List saved conversation sessions
  sauron debate "<q>"     Run multi-model debate
  sauron distill          Inspect distilled routing performance
`);
      break;
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
