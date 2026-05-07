# Slice 6 — Data Integrity Notes

## What this slice changed

**ADDITIVE only.** Two new tables (`workflow_runs`, `workflow_stages`)
created via `CREATE TABLE IF NOT EXISTS` inside the existing
`createSchema()` block in `src/db.ts`. No `ALTER` on any existing
table. No `mission_tasks` schema change.

## `git diff main -- src/db.ts` shape

The diff against main contains only:

1. Two new `CREATE TABLE IF NOT EXISTS` blocks at the bottom of
   `createSchema()` (workflow_runs, workflow_stages, plus indexes).
2. A new section of helper functions (`createWorkflowRun`,
   `getWorkflowRun`, `createWorkflowStage`, etc.) inserted between
   `resetStuckMissionTasks` (mission_tasks section) and `// ── Meet
   Sessions` (next section).

There is no edit, replace, or restructure of any existing function,
table, or index.

## Schema invariants (pre/post)

| Invariant | Pre (parent DB) | Post (worktree DB) | Result |
|---|---|---|---|
| `mission_tasks` schema | recorded in data-integrity-pre.txt | bit-identical, recorded in data-integrity-post.txt | MATCH |
| `idx_mission_status` index | present | present | MATCH |
| `hive_mind` columns | id, agent_id, chat_id, action, summary, artifacts, created_at | identical | MATCH |
| `launchctl claudeclaw` count | 8 | 8 | MATCH |
| All-tables list | all tables present | all original tables present + 2 new | MATCH (additive) |

The pre-baseline was captured against the parent repo's production
`store/claudeclaw.db` to lock the **schema** invariant before this
slice ran. The post-baseline was captured against the isolated
worktree DB after running the proof script. The comparison is
schema/shape, not row counts.

## Workflow vs solo mission_tasks separation

Of the 8 mission_tasks created during proof:
- 6 are workflow-spawned (`created_by = 'workflow'`)
- 1 is the escalation task (`created_by = 'workflow-escalation'`)
- 1 is a solo task (`created_by = 'proof'`) used for the regression test

`isWorkflowMissionTask()` correctly returns true for the 7 workflow
rows and false for the 1 solo row. No PreToolUse hook is injected for
the solo path: `src/scheduler.ts` was not modified, and it does not
import `workflow-spawner.ts` (the only place the hook lives).

## mission_tasks math invariants from the proof script

| Test | Expected delta | Observed delta | Result |
|---|---|---|---|
| 2-stage sequential workflow | +2 | +2 | PASS |
| 3-agent council workflow | +3 | +3 | PASS |
| Escalation (1 attempt + escalation row) | +2 | +2 | PASS |
| Solo mission_task | +1 | +1 | PASS |

Total: +8 matches the post count of 8.
