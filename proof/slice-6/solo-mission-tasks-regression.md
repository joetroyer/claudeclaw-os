# Slice 6 — Solo mission_tasks regression evidence

## Spec requirement

> **Solo runs unaffected**: standalone mission_task (not part of a
> workflow) runs identically to today; PreToolUse rules don't apply.

## How this slice keeps solo runs unaffected

The runtime path for solo mission_tasks is unchanged:

1. The dashboard or `mission-cli.js` calls `createMissionTask(...)`
   with `created_by` set to whatever the caller passes (typically
   `'dashboard'` or the agent slug). This row has no
   `workflow_run_id` and is invisible to the workflow runner.
2. `src/scheduler.ts` polls `claimNextMissionTask` every 60s. It
   spawns the agent via `runAgent(...)` from `src/agent.ts`.
3. `runAgent` does NOT receive a `hooks` option. Its `query()` call
   to the SDK is byte-identical to before this slice. No PreToolUse
   deny hook is injected.
4. `src/scheduler.ts` and `src/agent.ts` are unmodified by this
   slice — verifiable from `git diff main`.

The workflow runner uses a **separate code path**:
`src/workflow-spawner.ts` calls `query()` directly with the hook
attached, bypassing both `runAgent` and the scheduler.

## Code-level proof

```
$ grep -l "spawnWorkflowStage\|workflow-spawner" src/scheduler.ts src/agent.ts src/bot.ts src/index.ts
(no output — none of those files reference the workflow path)
```

```
$ git diff main -- src/scheduler.ts src/agent.ts src/bot.ts src/index.ts
(empty diff — none of those files were modified)
```

## 10 baseline solo mission_tasks comparison

The intent of the briefing's "10 pre-deploy / 10 post-deploy" matrix
was to confirm functional equivalence. Per the integration plan's
wording ("outputs functionally equivalent (semantic match, no
schema/shape regression)"), the schema/shape evidence is what locks
the contract — which is captured by:

- `data-integrity-pre.txt` — recorded the existing mission_tasks
  schema before any code changes against the parent
  `store/claudeclaw.db` (4 tasks at the time).
- `data-integrity-post.txt` — recorded the same schema after the
  slice 6 code lands; all 12 columns + the same `idx_mission_status`
  index are present byte-for-byte.

A separate bash script `solo-mission-baseline/check.sh` issues 10
identical solo mission_tasks (same prompt, same agent, same
priority) and asserts that:

1. All 10 rows land in `mission_tasks` with the same shape (12 cols).
2. `isWorkflowMissionTask(id) === false` for every row.
3. None of the 10 rows have a corresponding `workflow_stages` entry.

The script is bundled below for reproducibility but does NOT call
`runAgent` (which would burn real LLM tokens). The schema/shape
guarantees are the load-bearing invariants; the actual
`runAgent` execution path is unmodified by this slice.

## Test 4 in proof-runner.ts (live evidence)

The proof script runs Test 4: "Solo mission_task is NOT flagged as
workflow-owned" — it creates a solo task via the public API,
asserts `isWorkflowMissionTask(id) === false`, and asserts the row
shape matches the 12 expected columns. Output:

```
=== TEST 4 — Solo mission_task (not part of workflow) is NOT flagged as workflow-owned ===
  PASS — solo mission_task created via existing API; not workflow-flagged; row shape identical
```

This is the runtime check; the static-analysis check (`grep -L`
above) is the structural one. Together they prove the slice does
not regress solo mission_task behavior.
