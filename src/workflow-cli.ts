#!/usr/bin/env node
/**
 * Slice 6 — Workflow CLI.
 *
 * Used by Joe (and any agent) to dispatch a workflow run by slug.
 * Workflow runs are visible in Mission Control via the workflow_runs
 * table; each stage spawns a mission_tasks row for parity.
 *
 * Usage:
 *   node dist/workflow-cli.js list
 *   node dist/workflow-cli.js show <slug>
 *   node dist/workflow-cli.js dispatch <slug> "input prompt"
 *   node dist/workflow-cli.js status <run-id>
 *   node dist/workflow-cli.js advance <run-id>      # advance one stage (sync)
 *   node dist/workflow-cli.js run <run-id>          # run to completion (sync)
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowStages,
  listWorkflowRuns,
} from './db.js';
import { listWorkflowSlugs, loadWorkflow } from './workflow-loader.js';
import { advanceWorkflowOnce, runWorkflowToCompletion } from './workflow-runner.js';
import type { WorkflowRunPayload } from './workflow-types.js';

initDatabase();

const [, , command, ...rest] = process.argv;

function newRunId(): string {
  return randomBytes(6).toString('hex');
}

async function main(): Promise<void> {
  switch (command) {
    case 'list': {
      const slugs = listWorkflowSlugs();
      if (slugs.length === 0) {
        console.log('No workflows defined. Add one at workflows/<slug>.yaml.');
        return;
      }
      console.log(`${slugs.length} workflow${slugs.length === 1 ? '' : 's'}:\n`);
      for (const slug of slugs) {
        try {
          const def = loadWorkflow(slug);
          console.log(`  ${slug}  —  ${def.title}`);
          console.log(`    stages: ${def.stages.length}  default_consensus: ${def.default_consensus}`);
        } catch (err) {
          console.log(`  ${slug}  —  [INVALID: ${(err as Error).message}]`);
        }
      }
      break;
    }

    case 'show': {
      const slug = rest[0];
      if (!slug) {
        console.error('Usage: workflow-cli show <slug>');
        process.exit(1);
      }
      const def = loadWorkflow(slug);
      console.log(JSON.stringify(def, null, 2));
      break;
    }

    case 'dispatch': {
      const slug = rest[0];
      const input = rest.slice(1).join(' ');
      if (!slug) {
        console.error('Usage: workflow-cli dispatch <slug> "input prompt"');
        process.exit(1);
      }
      const def = loadWorkflow(slug);
      const id = newRunId();
      const payload: WorkflowRunPayload = { input: input ?? '', outputs: {}, attempts: {} };
      const createdBy = process.env.CLAUDECLAW_AGENT_ID ?? 'cli';
      createWorkflowRun(id, def.slug, JSON.stringify(payload), createdBy);
      console.log(`Workflow run created: ${id}`);
      console.log(`  Slug:    ${def.slug}`);
      console.log(`  Title:   ${def.title}`);
      console.log(`  Stages:  ${def.stages.length}`);
      console.log(`  Input:   ${(input ?? '').slice(0, 120)}`);
      console.log(`\nUse 'workflow-cli run ${id}' to execute synchronously,`);
      console.log(`or wait for the daemon poller to pick it up.`);
      break;
    }

    case 'status': {
      const id = rest[0];
      if (!id) {
        console.error('Usage: workflow-cli status <run-id>');
        process.exit(1);
      }
      const run = getWorkflowRun(id);
      if (!run) {
        console.error(`Run not found: ${id}`);
        process.exit(1);
      }
      const stages = getWorkflowStages(id);
      console.log(`Run ${run.id} [${run.state}]`);
      console.log(`  Slug:          ${run.workflow_slug}`);
      console.log(`  Current stage: ${run.current_stage}`);
      console.log(`  Started:       ${new Date(run.started_at * 1000).toISOString()}`);
      if (run.finished_at) console.log(`  Finished:      ${new Date(run.finished_at * 1000).toISOString()}`);
      console.log(`\nStages (${stages.length}):`);
      for (const s of stages) {
        console.log(`  [${s.stage_idx} ${s.stage_type}/${s.agent_id} attempt ${s.attempt}] verdict=${s.verdict ?? '-'} mission=${s.mission_task_id ?? '-'}`);
      }
      const payload: WorkflowRunPayload = JSON.parse(run.payload_json || '{}');
      if (payload.last_error) console.log(`\nLast error: ${payload.last_error}`);
      break;
    }

    case 'advance': {
      const id = rest[0];
      if (!id) {
        console.error('Usage: workflow-cli advance <run-id>');
        process.exit(1);
      }
      const more = await advanceWorkflowOnce(id);
      const after = getWorkflowRun(id);
      console.log(`State: ${after?.state} (more stages pending: ${more})`);
      break;
    }

    case 'run': {
      const id = rest[0];
      if (!id) {
        console.error('Usage: workflow-cli run <run-id>');
        process.exit(1);
      }
      const finalState = await runWorkflowToCompletion(id);
      console.log(`Final state: ${finalState}`);
      break;
    }

    case 'runs': {
      const runs = listWorkflowRuns(50);
      if (runs.length === 0) {
        console.log('No workflow runs.');
        return;
      }
      for (const r of runs) {
        console.log(`${r.id} [${r.state}] ${r.workflow_slug} stage=${r.current_stage} created_by=${r.created_by}`);
      }
      break;
    }

    default:
      console.error('Commands: list | show <slug> | dispatch <slug> "input" | status <id> | advance <id> | run <id> | runs');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
