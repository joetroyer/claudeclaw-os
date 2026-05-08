#!/usr/bin/env node
/**
 * ClaudeClaw Schedule CLI
 *
 * Used by your Claude assistant via the Bash tool to manage scheduled tasks.
 *
 * Usage:
 *   node dist/schedule-cli.js create "prompt text" "0 9 * * 1" [--silent] [--silent-result]
 *   node dist/schedule-cli.js list
 *   node dist/schedule-cli.js delete <id>
 *   node dist/schedule-cli.js pause <id>
 *   node dist/schedule-cli.js resume <id>
 *   node dist/schedule-cli.js silent <id>            # toggle ON  silent_start  (no pre-announce)
 *   node dist/schedule-cli.js unsilent <id>          # toggle OFF silent_start
 *   node dist/schedule-cli.js silent-result <id>     # toggle ON  silent_result (no result message)
 *   node dist/schedule-cli.js unsilent-result <id>   # toggle OFF silent_result
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  setScheduledTaskSilent,
  setScheduledTaskSilentResult,
} from './db.js';
import { computeNextRun } from './scheduler.js';

initDatabase();

// Parse --agent flag from anywhere in argv, fall back to CLAUDECLAW_AGENT_ID env var
const agentFlagIdx = process.argv.indexOf('--agent');
const cliAgentId = agentFlagIdx !== -1
  ? process.argv[agentFlagIdx + 1] ?? 'main'
  : process.env.CLAUDECLAW_AGENT_ID ?? 'main';
let cleanedArgv = agentFlagIdx !== -1
  ? process.argv.filter((_, i) => i !== agentFlagIdx && i !== agentFlagIdx + 1)
  : [...process.argv];

// Parse --silent and --silent-result flags (boolean, removed from rest args)
const silentFlag = cleanedArgv.includes('--silent');
const silentResultFlag = cleanedArgv.includes('--silent-result');
cleanedArgv = cleanedArgv.filter((a) => a !== '--silent' && a !== '--silent-result');

const [, , command, ...rest] = cleanedArgv;

function formatDate(unix: number | null): string {
  if (!unix) return 'never';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

switch (command) {
  case 'create': {
    const prompt = rest[0];
    const cron = rest[1];

    if (!prompt || !cron) {
      console.error('Usage: schedule-cli create "prompt" "cron expression" [--silent] [--silent-result]');
      console.error('Example: schedule-cli create "Summarise AI news" "0 9 * * 1"');
      console.error('  --silent         suppress the "Scheduled task running" Telegram pre-announce');
      console.error('  --silent-result  suppress the result message on Telegram (errors and timeouts still ping)');
      process.exit(1);
    }

    let nextRun: number;
    try {
      nextRun = computeNextRun(cron);
    } catch {
      console.error(`Invalid cron expression: "${cron}"`);
      console.error('Examples: "0 9 * * 1" (Mon 9am)  "0 8 * * *" (daily 8am)  "0 */4 * * *" (every 4h)');
      process.exit(1);
    }

    const id = randomBytes(4).toString('hex');
    createScheduledTask(id, prompt, cron, nextRun, cliAgentId, silentFlag, silentResultFlag);

    console.log(`Task created:  ${id}`);
    console.log(`Agent:         ${cliAgentId}`);
    console.log(`Prompt:        ${prompt}`);
    console.log(`Schedule:      ${cron}`);
    console.log(`Silent start:  ${silentFlag ? 'yes' : 'no'}`);
    console.log(`Silent result: ${silentResultFlag ? 'yes' : 'no'}`);
    console.log(`Next run:      ${formatDate(nextRun)}`);
    break;
  }

  case 'list': {
    const tasks = getAllScheduledTasks(cliAgentId === 'main' ? undefined : cliAgentId);
    if (tasks.length === 0) {
      console.log('No scheduled tasks.');
      break;
    }
    console.log(`${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}:\n`);
    for (const t of tasks) {
      const status = t.status === 'paused' ? ' [PAUSED]' : '';
      const silent = t.silent_start ? ' [SILENT-START]' : '';
      const silentRes = t.silent_result ? ' [SILENT-RESULT]' : '';
      console.log(`${t.id}${status}${silent}${silentRes}`);
      console.log(`  Prompt:   ${t.prompt}`);
      console.log(`  Schedule: ${t.schedule}`);
      console.log(`  Next run: ${formatDate(t.next_run)}`);
      console.log(`  Last run: ${formatDate(t.last_run)}`);
      console.log();
    }
    break;
  }

  case 'delete': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli delete <id>'); process.exit(1); }
    deleteScheduledTask(id);
    console.log(`Deleted task: ${id}`);
    break;
  }

  case 'pause': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli pause <id>'); process.exit(1); }
    pauseScheduledTask(id);
    console.log(`Paused task: ${id}`);
    break;
  }

  case 'resume': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli resume <id>'); process.exit(1); }
    resumeScheduledTask(id);
    console.log(`Resumed task: ${id}`);
    break;
  }

  case 'silent': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli silent <id>'); process.exit(1); }
    setScheduledTaskSilent(id, true);
    console.log(`Task ${id}: silent start enabled (no Telegram pre-announce)`);
    break;
  }

  case 'unsilent': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli unsilent <id>'); process.exit(1); }
    setScheduledTaskSilent(id, false);
    console.log(`Task ${id}: silent start disabled (Telegram pre-announce restored)`);
    break;
  }

  case 'silent-result': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli silent-result <id>'); process.exit(1); }
    setScheduledTaskSilentResult(id, true);
    console.log(`Task ${id}: silent result enabled (no Telegram result ping; errors/timeouts still alert)`);
    break;
  }

  case 'unsilent-result': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli unsilent-result <id>'); process.exit(1); }
    setScheduledTaskSilentResult(id, false);
    console.log(`Task ${id}: silent result disabled (Telegram result ping restored)`);
    break;
  }

  default:
    console.error('Commands: create | list | delete | pause | resume | silent | unsilent | silent-result | unsilent-result');
    process.exit(1);
}
