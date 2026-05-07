/**
 * Slice 6 — Workflow runner.
 *
 * Long-poll loop that picks up `workflow_runs` rows in state 'queued' or
 * 'running' and advances them stage-by-stage. Each stage:
 *   1. Inserts a mission_tasks row for visibility (so the dashboard's
 *      existing Mission Control UI lists workflow stages alongside solo
 *      tasks). The mission_task is OWNED by this runner — the scheduler
 *      will not pick it up because we mark it 'running' immediately.
 *   2. Calls `spawnWorkflowStage` which invokes the SDK with a
 *      per-spawn PreToolUse deny hook scoped to the stage's allowed
 *      paths.
 *   3. Records the verdict + output on workflow_stages, completes the
 *      mission_task, and advances `current_stage`.
 *
 * Council stages spawn N stages in parallel and only advance when
 * consensus is reached per the configured rule.
 *
 * Failures retry up to `on_failure.retries`; after exhaustion the runner
 * creates an escalation mission_task assigned to `on_failure.escalate_to`
 * (or unassigned for `'human'`) with the workflow's history attached.
 */

import { randomBytes } from 'crypto';

import {
  createMissionTask,
  completeMissionTask,
  createWorkflowStage,
  setWorkflowStageMissionTask,
  completeWorkflowStage,
  getWorkflowRun,
  getWorkflowStages,
  listActiveWorkflowRuns,
  updateWorkflowRunState,
  type WorkflowState,
} from './db.js';
import Database from 'better-sqlite3';
import path from 'path';
import { STORE_DIR } from './config.js';
import { loadWorkflow, effectiveAllowedPaths } from './workflow-loader.js';
import { logger } from './logger.js';
import { spawnWorkflowStage } from './workflow-spawner.js';
import type {
  ConsensusRule,
  StageSpec,
  SequentialStageSpec,
  CouncilStageSpec,
  WorkflowDefinition,
  WorkflowRunPayload,
} from './workflow-types.js';

/** Max time per stage spawn before we consider it timed out. */
const STAGE_TIMEOUT_MS = 10 * 60 * 1000;

/** Re-poll interval. */
const POLL_INTERVAL_MS = 5_000;

/** Markers in the prompt the runner replaces before spawning. */
function interpolatePrompt(template: string, vars: { input: string; previous_output: string }): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, vars.input)
    .replace(/\{\{\s*previous_output\s*\}\}/g, vars.previous_output);
}

function newId(): string {
  return randomBytes(4).toString('hex');
}

/** Insert a mission_task to record this stage execution AND mark it
 *  running atomically so the scheduler poll won't claim it. */
function recordMissionTaskForStage(
  agentId: string,
  title: string,
  prompt: string,
): string {
  const id = newId();
  createMissionTask(id, title, prompt, agentId, 'workflow', 5);
  // Flip to running immediately. We do NOT use claimNextMissionTask
  // because that path is owned by src/scheduler.ts; we own these rows.
  // Direct UPDATE keeps this surgical.
  const dbPath = path.join(STORE_DIR, 'claudeclaw.db');
  const db = new Database(dbPath);
  try {
    db.prepare(
      `UPDATE mission_tasks SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(Math.floor(Date.now() / 1000), id);
  } finally {
    db.close();
  }
  return id;
}

/** Evaluate council consensus given verdicts and the rule. */
export function evaluateConsensus(
  verdicts: Array<'APPROVED' | 'REJECTED' | 'UNKNOWN'>,
  rule: ConsensusRule,
  threshold?: number,
): { consensus: boolean; approvals: number; rejections: number; total: number } {
  const total = verdicts.length;
  const approvals = verdicts.filter((v) => v === 'APPROVED').length;
  const rejections = total - approvals;
  if (rule === 'unanimous') {
    return { consensus: approvals === total && total > 0, approvals, rejections, total };
  }
  if (rule === 'threshold') {
    const need = threshold ?? Math.ceil(total / 2 + 1);
    return { consensus: approvals >= need, approvals, rejections, total };
  }
  // majority — strictly more than half
  return { consensus: approvals * 2 > total, approvals, rejections, total };
}

/** Public entrypoint for tests + CLI: synchronously advance a single run
 *  to completion (or until it errors / escalates). Returns the final
 *  state. Used by playwright/proof scripts. */
export async function runWorkflowToCompletion(runId: string): Promise<WorkflowState> {
  let safetyCounter = 0;
  while (safetyCounter++ < 50) {
    const advanced = await advanceWorkflowOnce(runId);
    if (!advanced) break;
  }
  const final = getWorkflowRun(runId);
  return (final?.state as WorkflowState) ?? 'failed';
}

/**
 * Advance the workflow by one stage (sequential) or by one council
 * round. Returns true if the run is still active (more stages to do)
 * or false if it has reached a terminal state (done/failed/escalated).
 */
export async function advanceWorkflowOnce(runId: string): Promise<boolean> {
  const run = getWorkflowRun(runId);
  if (!run) {
    logger.warn({ runId }, 'Slice 6 advance: run not found');
    return false;
  }
  if (run.state === 'done' || run.state === 'failed' || run.state === 'escalated') {
    return false;
  }

  let def: WorkflowDefinition;
  try {
    def = loadWorkflow(run.workflow_slug);
  } catch (err) {
    logger.error({ runId, err: (err as Error).message }, 'Slice 6: workflow YAML invalid, failing run');
    updateWorkflowRunState(runId, 'failed');
    return false;
  }

  const payload: WorkflowRunPayload = JSON.parse(run.payload_json || '{}');
  payload.outputs ??= {};
  payload.attempts ??= {};
  payload.input ??= '';

  if (run.current_stage >= def.stages.length) {
    // All stages done.
    updateWorkflowRunState(runId, 'done', JSON.stringify(payload), run.current_stage);
    logger.info({ runId, slug: def.slug }, 'Slice 6 workflow completed');
    return false;
  }

  const stageIdx = run.current_stage;
  const stage = def.stages[stageIdx]!;
  const allowed = effectiveAllowedPaths(def, stage);
  const previousOutput = payload.outputs[stageIdx - 1] ?? '';

  // Mark running on first dispatch.
  if (run.state === 'queued') {
    updateWorkflowRunState(runId, 'running', JSON.stringify(payload), stageIdx);
  }

  const attempt = (payload.attempts[stageIdx] ?? 0) + 1;
  payload.attempts[stageIdx] = attempt;

  if (stage.type === 'sequential') {
    return runSequentialStage(runId, def, stage, stageIdx, attempt, allowed, payload, previousOutput);
  }
  return runCouncilStage(runId, def, stage, stageIdx, attempt, allowed, payload, previousOutput);
}

async function runSequentialStage(
  runId: string,
  def: WorkflowDefinition,
  stage: SequentialStageSpec,
  stageIdx: number,
  attempt: number,
  allowed: string[],
  payload: WorkflowRunPayload,
  previousOutput: string,
): Promise<boolean> {
  const prompt = interpolatePrompt(stage.prompt, { input: payload.input, previous_output: previousOutput });
  const stageRowId = createWorkflowStage(runId, stageIdx, 'sequential', stage.agent, attempt);
  const title = `wf:${def.slug}#${stageIdx} ${stage.name} (attempt ${attempt})`;
  const missionId = recordMissionTaskForStage(stage.agent, title, prompt);
  setWorkflowStageMissionTask(stageRowId, missionId);

  const ac = new AbortController();
  const timeoutHandle = setTimeout(() => ac.abort(), STAGE_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof spawnWorkflowStage>>;
  try {
    res = await spawnWorkflowStage({
      agentId: stage.agent,
      prompt,
      allowedPaths: allowed,
      stageLabel: stage.name,
      runId,
      abortController: ac,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const errMsg = (err as Error).message ?? String(err);
    completeWorkflowStage(stageRowId, 'ERROR', errMsg.slice(0, 2000));
    completeMissionTask(missionId, null, 'failed', errMsg.slice(0, 500));
    return await handleStageFailure(runId, def, stage, stageIdx, payload, errMsg);
  }
  clearTimeout(timeoutHandle);

  const text = res.text ?? '';
  completeMissionTask(missionId, text.slice(0, 4000), res.verdict === 'REJECTED' || res.aborted ? 'failed' : 'completed', res.aborted ? 'aborted/timeout' : undefined);
  completeWorkflowStage(stageRowId, res.verdict, text.slice(0, 4000));

  if (res.aborted) {
    return await handleStageFailure(runId, def, stage, stageIdx, payload, 'stage aborted/timeout');
  }
  if (res.verdict === 'REJECTED') {
    return await handleStageFailure(runId, def, stage, stageIdx, payload, `stage REJECTED: ${text.slice(0, 200)}`);
  }

  // Success path — record output and advance.
  payload.outputs[stageIdx] = text;
  const nextStage = stageIdx + 1;
  const isLast = nextStage >= def.stages.length;
  updateWorkflowRunState(runId, isLast ? 'approved' : 'running', JSON.stringify(payload), nextStage);
  if (isLast) {
    // Approved means consensus/output ok; we still want a 'done' marker
    // for finished runs. Sequential workflows complete as 'done'.
    updateWorkflowRunState(runId, 'done', JSON.stringify(payload), nextStage);
    return false;
  }
  return true;
}

async function runCouncilStage(
  runId: string,
  def: WorkflowDefinition,
  stage: CouncilStageSpec,
  stageIdx: number,
  attempt: number,
  allowed: string[],
  payload: WorkflowRunPayload,
  previousOutput: string,
): Promise<boolean> {
  const prompt = interpolatePrompt(stage.prompt, { input: payload.input, previous_output: previousOutput });
  const rule: ConsensusRule = stage.consensus ?? def.default_consensus ?? 'majority';

  const memberStageIds: number[] = [];
  const memberMissionIds: string[] = [];
  // Spawn each council member in parallel.
  const spawns = stage.agents.map(async (memberAgent) => {
    const stageRowId = createWorkflowStage(runId, stageIdx, 'council', memberAgent, attempt);
    memberStageIds.push(stageRowId);
    const title = `wf:${def.slug}#${stageIdx} council/${memberAgent} (attempt ${attempt})`;
    const missionId = recordMissionTaskForStage(memberAgent, title, prompt);
    memberMissionIds.push(missionId);
    setWorkflowStageMissionTask(stageRowId, missionId);

    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), STAGE_TIMEOUT_MS);
    try {
      const res = await spawnWorkflowStage({
        agentId: memberAgent,
        prompt,
        allowedPaths: allowed,
        stageLabel: `${stage.name}/${memberAgent}`,
        runId,
        abortController: ac,
      });
      clearTimeout(timeoutHandle);
      const text = res.text ?? '';
      completeMissionTask(missionId, text.slice(0, 4000), res.aborted ? 'failed' : 'completed', res.aborted ? 'aborted/timeout' : undefined);
      completeWorkflowStage(stageRowId, res.verdict, text.slice(0, 4000));
      return { agent: memberAgent, verdict: res.verdict, text };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const errMsg = (err as Error).message ?? String(err);
      completeWorkflowStage(stageRowId, 'ERROR', errMsg.slice(0, 2000));
      completeMissionTask(missionId, null, 'failed', errMsg.slice(0, 500));
      return { agent: memberAgent, verdict: 'UNKNOWN' as const, text: '' };
    }
  });

  const results = await Promise.all(spawns);
  const verdicts = results.map((r) => r.verdict);
  const consensus = evaluateConsensus(verdicts, rule, stage.threshold);

  if (!consensus.consensus) {
    return await handleStageFailure(
      runId,
      def,
      stage,
      stageIdx,
      payload,
      `council ${rule} consensus failed: ${consensus.approvals}/${consensus.total} approved`,
    );
  }

  // Council passed — record outputs as JSON-encoded array.
  payload.outputs[stageIdx] = JSON.stringify(results.map((r) => ({ agent: r.agent, verdict: r.verdict, text: r.text })));
  const nextStage = stageIdx + 1;
  const isLast = nextStage >= def.stages.length;
  updateWorkflowRunState(runId, isLast ? 'done' : 'running', JSON.stringify(payload), nextStage);
  return !isLast;
}

async function handleStageFailure(
  runId: string,
  def: WorkflowDefinition,
  stage: StageSpec,
  stageIdx: number,
  payload: WorkflowRunPayload,
  reason: string,
): Promise<boolean> {
  payload.last_error = reason.slice(0, 1000);
  const attemptCount = payload.attempts[stageIdx] ?? 1;
  const maxRetries = stage.on_failure.retries;
  if (attemptCount <= maxRetries) {
    logger.warn(
      { runId, stage: stage.name, attempt: attemptCount, maxRetries, reason },
      'Slice 6: stage failed, retrying',
    );
    // Re-queue: don't bump current_stage; advance loop will re-spawn.
    updateWorkflowRunState(runId, 'running', JSON.stringify(payload), stageIdx);
    return true;
  }

  // Escalate.
  logger.warn(
    { runId, stage: stage.name, attempt: attemptCount, target: stage.on_failure.escalate_to, reason },
    'Slice 6: stage failed beyond retries, escalating',
  );
  const escalateTo = stage.on_failure.escalate_to === 'human' ? null : stage.on_failure.escalate_to;
  const history = formatRunHistory(runId);
  const escalationPrompt =
    `Workflow ${def.slug} (run ${runId}) failed at stage "${stage.name}" (idx ${stageIdx}).\n\n` +
    `Reason: ${reason}\n\n` +
    `Full history:\n${history}\n\n` +
    `Original input:\n${payload.input}`;
  const escalationId = newId();
  createMissionTask(
    escalationId,
    `[ESCALATION] ${def.slug}/${stage.name} failed`,
    escalationPrompt,
    escalateTo,
    'workflow-escalation',
    8,
  );
  payload.last_error = `escalated to ${escalateTo ?? 'human (unassigned)'} as task ${escalationId}`;
  updateWorkflowRunState(runId, 'escalated', JSON.stringify(payload), stageIdx);
  return false;
}

function formatRunHistory(runId: string): string {
  const stages = getWorkflowStages(runId);
  const lines: string[] = [];
  for (const s of stages) {
    lines.push(
      `[stage ${s.stage_idx} ${s.stage_type}/${s.agent_id} attempt ${s.attempt}] verdict=${s.verdict ?? 'pending'}`,
    );
    if (s.output) {
      lines.push(`  output: ${s.output.slice(0, 400).replace(/\n/g, ' ')}`);
    }
  }
  return lines.join('\n');
}

// ── Daemon poller (used by index.ts at startup) ────────────────────

let runningPoll = false;
let pollerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start a long-poll loop that advances active workflow runs every
 * POLL_INTERVAL_MS. Idempotent: subsequent calls are no-ops.
 *
 * Wired into src/index.ts on the main agent boot path so workflow_runs
 * advance autonomously without any direct call to
 * `runWorkflowToCompletion()`. Lives in the main process only (single
 * owner) — sub-agent processes do not poll, so we never double-advance
 * the same run.
 */
export function startWorkflowDaemon(): void {
  if (pollerInterval) return;
  pollerInterval = setInterval(async () => {
    if (runningPoll) return;
    runningPoll = true;
    try {
      const active = listActiveWorkflowRuns();
      for (const run of active) {
        try {
          // advance one step per tick to keep the daemon yielding.
          await advanceWorkflowOnce(run.id);
        } catch (err) {
          logger.error({ runId: run.id, err: (err as Error).message }, 'Slice 6 advance error');
        }
      }
    } finally {
      runningPoll = false;
    }
  }, POLL_INTERVAL_MS);
  logger.info('Slice 6 workflow daemon started');
}

export function stopWorkflowDaemon(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
