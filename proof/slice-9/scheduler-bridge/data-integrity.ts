// Synthetic scheduler→mission_tasks fire. Boots the same in-memory test
// database used by vitest, drives `executeScheduledTask` once with a
// stubbed runAgent, and dumps before/after row counts + the new
// mission_tasks row so the proof artifacts show the bridge actually
// emits a row stamped with source='scheduled' + source_id=<scheduled.id>.
//
// Run from the worktree root via tsx:
//   npx tsx proof/slice-9/scheduler-bridge/data-integrity.ts        > proof/slice-9/scheduler-bridge/data-integrity-post.txt
//   npx tsx proof/slice-9/scheduler-bridge/data-integrity.ts --pre  > proof/slice-9/scheduler-bridge/data-integrity-pre.txt

import {
  _initTestDatabase,
  createScheduledTask,
  getScheduledTask,
  getMissionTasks,
} from '../../../src/db.js';
import { executeScheduledTask } from '../../../src/scheduler.js';

_initTestDatabase();

const pre = getMissionTasks();
console.log('--- BEFORE FIRE ---');
console.log('mission_tasks count:', pre.length);
console.log('rows:', JSON.stringify(pre, null, 2));

if (process.argv.includes('--pre')) process.exit(0);

const past = Math.floor(Date.now() / 1000) - 60;
createScheduledTask('proof-cron', 'morning briefing', '0 9 * * *', past, 'main');
const task = getScheduledTask('proof-cron');
if (!task) throw new Error('seed task missing');

const fakeRunner = (async (..._args: unknown[]) => ({
  text: 'Briefing: 3 emails, 2 meetings.',
  aborted: false,
})) as never;
const noopSender = async (_text: string): Promise<void> => {};

await executeScheduledTask(task, past + 86400, fakeRunner, noopSender);

const post = getMissionTasks();
console.log('\n--- AFTER FIRE ---');
console.log('mission_tasks count:', post.length);
console.log('rows:', JSON.stringify(post, null, 2));

console.log('\n--- DELTA ---');
console.log('rows added:', post.length - pre.length);
console.log('source values present:', [...new Set(post.map((r) => r.source))]);
console.log('source_id values present:', [...new Set(post.map((r) => r.source_id))]);
