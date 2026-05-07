#!/usr/bin/env node
/**
 * Slice 6 — Daemon autonomy proof.
 *
 * Reviewer ask: prove the workflow daemon (the same `startWorkflowDaemon()`
 * wired into `src/index.ts` at boot) advances a queued workflow_run all
 * the way to `state='done'` on its own — with NO direct call to
 * `runWorkflowToCompletion()` and NO direct call to
 * `advanceWorkflowOnce()` from this script.
 *
 * What this script does (and what it pointedly does NOT do):
 *
 *   1. Insert a queued `workflow_run` row directly via `createWorkflowRun()`.
 *   2. Call `startWorkflowDaemon()` — the exact same function the main
 *      process calls in `src/index.ts:188`.
 *   3. Poll the DB (read-only) until `workflow_runs.state='done'` or
 *      timeout.
 *   4. Stop the daemon, assert: state === 'done', stages all completed,
 *      stages count === workflow definition stages count.
 *
 *   The script imports neither `runWorkflowToCompletion` nor
 *   `advanceWorkflowOnce`. That is intentional. The only code path that
 *   advances the workflow is the daemon's own setInterval poll loop.
 *
 * Stub mode is used so this is reproducible without real LLM tokens —
 * the same pattern the existing `proof-runner.ts` uses. Stub mode only
 * affects `spawnWorkflowStage`; it does NOT short-circuit the daemon's
 * poll loop, the state-machine transitions, or the DB writes.
 *
 * Run:
 *   /opt/homebrew/Cellar/node@20/20.19.6/bin/node \
 *     --import tsx proof/slice-6/daemon-autonomy-test.ts
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowStages,
} from '../../src/db.js';
import { startWorkflowDaemon, stopWorkflowDaemon } from '../../src/workflow-runner.js';
import { enableStubMode, disableStubMode } from '../../src/workflow-spawner.js';

initDatabase();

function newId(): string { return randomBytes(6).toString('hex'); }

function ok(text: string): void { console.log(`  PASS — ${text}`); }
function fail(text: string): never {
  console.error(`  FAIL — ${text}`);
  process.exit(1);
}

function header(text: string): void {
  console.log(`\n=== ${text} ===`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the workflow_run to reach a terminal state. Reads the DB
 * directly via getWorkflowRun() — does NOT touch the runner's advance
 * functions. The only advancement comes from the daemon's poll tick.
 */
async function waitForTerminalState(
  runId: string,
  timeoutMs: number,
): Promise<{ state: string; ticks: number; elapsedMs: number }> {
  const startedAt = Date.now();
  let ticks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    ticks += 1;
    const run = getWorkflowRun(runId);
    if (run && (run.state === 'done' || run.state === 'failed' || run.state === 'escalated')) {
      return { state: run.state, ticks, elapsedMs: Date.now() - startedAt };
    }
    await sleep(500);
  }
  const final = getWorkflowRun(runId);
  return { state: final?.state ?? 'missing', ticks, elapsedMs: Date.now() - startedAt };
}

async function main(): Promise<void> {
  console.log('Slice 6 — daemon autonomy proof');
  console.log('Strategy: insert queued workflow_run, start the daemon,');
  console.log('poll DB until state=done. NEVER call runWorkflowToCompletion().');
  console.log('NEVER call advanceWorkflowOnce(). The daemon\'s own poll loop');
  console.log('is the only thing that advances the workflow.');

  header('SETUP — script does not import runWorkflowToCompletion or advanceWorkflowOnce');
  console.log('  Imported from workflow-runner: startWorkflowDaemon, stopWorkflowDaemon');
  console.log('  (verified by inspecting the import block at top of this file).');

  // Stub mode: scripted APPROVED responses for the 2 stages of the
  // dev-fix-qa-verify workflow. This is the same fixture the existing
  // proof-runner uses for Test 1.
  enableStubMode([
    { text: 'fix applied to allowed paths\nVERDICT: APPROVED', verdict: 'APPROVED' },
    { text: 'verified the fix\nVERDICT: APPROVED', verdict: 'APPROVED' },
  ]);

  header('STEP 1 — Insert queued workflow_run directly into DB');
  const runId = newId();
  createWorkflowRun(
    runId,
    'dev-fix-qa-verify',
    JSON.stringify({ input: 'autonomy-proof: simulated bug', outputs: {}, attempts: {} }),
    'daemon-autonomy-proof',
  );
  const initial = getWorkflowRun(runId);
  if (!initial) fail(`workflow_run ${runId} was not inserted`);
  if (initial.state !== 'queued') fail(`expected initial state 'queued', got '${initial.state}'`);
  if (initial.current_stage !== 0) fail(`expected initial current_stage 0, got ${initial.current_stage}`);
  console.log(`  inserted run id=${runId} slug=${initial.workflow_slug} state=${initial.state} stage=${initial.current_stage}`);
  ok('queued workflow_run row exists, untouched by any runner code yet');

  header('STEP 2 — Start the workflow daemon (same function index.ts boots)');
  console.log('  calling startWorkflowDaemon() — identical to src/index.ts:188');
  startWorkflowDaemon();
  ok('daemon started; poll loop is now ticking every 5s in the background');

  header('STEP 3 — Poll DB until terminal state (timeout 60s)');
  console.log('  this loop only READS workflow_runs; advancement is the daemon\'s job');
  const result = await waitForTerminalState(runId, 60_000);
  console.log(`  reached state='${result.state}' after ${result.elapsedMs}ms (${result.ticks} read polls)`);

  header('STEP 4 — Stop daemon and disable stub mode');
  stopWorkflowDaemon();
  disableStubMode();
  ok('daemon stopped cleanly');

  header('STEP 5 — Assertions on terminal state');
  const finalRun = getWorkflowRun(runId);
  if (!finalRun) fail('workflow_run vanished');
  console.log(`  final state: ${finalRun.state}`);
  console.log(`  final current_stage: ${finalRun.current_stage}`);
  if (finalRun.state !== 'done') {
    fail(`expected final state 'done', got '${finalRun.state}'`);
  }

  const stages = getWorkflowStages(runId);
  console.log(`  workflow_stages rows: ${stages.length}`);
  for (const s of stages) {
    console.log(
      `    stage[${s.stage_idx} ${s.stage_type}/${s.agent_id} attempt=${s.attempt}] ` +
      `verdict=${s.verdict} mission=${s.mission_task_id ?? 'null'}`,
    );
  }
  if (stages.length !== 2) {
    fail(`expected 2 workflow_stages rows, got ${stages.length}`);
  }
  for (const s of stages) {
    if (s.verdict !== 'APPROVED') {
      fail(`stage ${s.stage_idx} expected APPROVED verdict, got ${s.verdict ?? 'null'}`);
    }
    if (!s.finished_at) {
      fail(`stage ${s.stage_idx} missing finished_at timestamp`);
    }
    if (!s.mission_task_id) {
      fail(`stage ${s.stage_idx} missing mission_task_id`);
    }
  }
  ok('state === done; both stages APPROVED; both stages finished_at set');

  header('PROOF SUMMARY');
  console.log(`  run id: ${runId}`);
  console.log(`  workflow: dev-fix-qa-verify (2 sequential stages)`);
  console.log(`  initial state: queued`);
  console.log(`  final state:   ${finalRun.state}`);
  console.log(`  advancement mechanism: startWorkflowDaemon() poll loop ONLY`);
  console.log('  this script never called runWorkflowToCompletion()');
  console.log('  this script never called advanceWorkflowOnce()');
  console.log('  (grep this file for those names — the only mentions are in this');
  console.log('   header comment and these log lines.)');
  console.log('\nDaemon autonomy proof: PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
