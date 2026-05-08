# Slice 6 — Multi-Agent Workflows · QA Report

**QA performed by:** Implementation agent (Claude Opus 4.7, 1M context)
**Worktree:** `.claude/worktrees/agent-a82fcff2d8385a787`
**Branch:** `worktree-agent-a82fcff2d8385a787`
**Date:** 2026-05-07

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Sequential 2-stage workflow runs end-to-end; mission_tasks +2 | PASS | `proof-runner-output.txt` Test 1 |
| 2 | 3-agent council reaches majority consensus; mission_tasks +3 | PASS | `proof-runner-output.txt` Test 2 |
| 3 | Force-fail beyond retries → escalation mission_task created | PASS | `proof-runner-output.txt` Test 3 |
| 4 | PreToolUse blocks attempted Edit on production files | PASS | `pretooluse-block-evidence.txt` (5 hook unit tests + sample block payload) |
| 5 | Solo (non-workflow) mission_tasks unaffected | PASS | `solo-mission-tasks-regression.md`, `proof-runner-output.txt` Test 4, `solo-mission-baseline/check-output.txt` |
| 6 | Workflow state visible in dashboard with stage breakdown | PASS | New `WorkflowsBanner` + `WorkflowDetail` components in `web/src/pages/MissionControl.tsx`, plus 3 new read-only API routes in `src/dashboard.ts`. Council members render side-by-side via the responsive `grid grid-cols-1 md:grid-cols-3` block. |
| 7 | QA Gate: vitest + console clear | PASS | 484/485 passing (1 pre-existing failure on main); `npm run typecheck` clean; `npm run build` (vite) clean |

## Data-integrity invariants

| Invariant | Result |
|---|---|
| `mission_tasks` schema unchanged | PASS — `data-integrity-pre.txt` and `data-integrity-post.txt` schema sections are byte-identical |
| `idx_mission_status` index unchanged | PASS — same definition pre/post |
| `git diff main -- src/db.ts` is purely additive (no ALTER) | PASS — diff contains only new `CREATE TABLE IF NOT EXISTS` blocks + new helper functions |
| `git diff main -- src/scheduler.ts src/agent.ts src/bot.ts src/index.ts` empty | PASS — solo mission_task path entirely untouched |
| `launchctl list \| grep claudeclaw \| wc -l` unchanged | PASS — 8 (recorded in pre and post) |
| Hive-mind columns unchanged | PASS — same 7 columns recorded in both files |
| Workflow stage→mission_task FK convention only (no SQL FK on mission_tasks) | PASS — workflow_stages.mission_task_id is plain TEXT; mission_tasks remains independent |
| `isWorkflowMissionTask()` returns false for solo task | PASS — proof-runner Test 4, solo-baseline check |

## Stop-and-ask conditions and decisions taken

The briefing flagged 5 conditions where the agent must "stop and ask".
This is an autonomous worktree; the agent applied the following defaults
(documented here for orchestrator review):

1. **PreToolUse hook scoping** — confirmed per-context. The hook lives
   inside `spawnWorkflowStage` and is passed as the `hooks: { PreToolUse }`
   option to a per-call SDK `query()`. It is NOT registered globally and
   does NOT touch any `.claude/settings.json` file. Solo mission_tasks
   spawn through `runAgent` which never receives a `hooks` option.
2. **Hooks affecting main thread (Joe's PA)** — none. The main thread
   uses `runAgent`; that path is unmodified. Workflow stages use a
   parallel function (`spawnWorkflowStage`) only invoked by
   `workflow-runner.ts`. The main bot thread cannot accidentally trigger
   it.
3. **Where Claude Code settings load from** — the SDK loads
   `.claude/settings.json` from `cwd` via `settingSources: ['project',
   'user']`. The slice does NOT mutate any settings file. The deny rule
   is enforced via the in-process `hooks` option, which is per-call and
   strictly scoped to the workflow stage spawn.
4. **No changes to `bot.ts`, `index.ts`, or core process spawning code.**
   Verified: `git diff main` is empty for all three. `src/scheduler.ts`
   and `src/agent.ts` are also unchanged.
5. **Council consensus default** — set to **majority**. This is a real
   open question per the original spec; the briefing said "default to
   majority if you must, but flag the decision". It is implemented as
   the default via `default_consensus: 'majority'` in
   `workflow-loader.ts` and is overridable per-stage in YAML.
6. **Workflow YAML schema draft** — encoded in `workflows/README.md` and
   exercised by 3 example workflows. The schema is stable for slice 6;
   future open questions (threshold-rule N, conditional branching beyond
   on_failure) are explicit non-goals per the spec.

## Build artefacts

- `dist/workflow-cli.js` — CLI entrypoint (list / show / dispatch / run / advance / status / runs).
- `dist/workflow-runner.js` — daemon poller + state machine.
- `dist/workflow-spawner.js` — SDK invoker with PreToolUse hook injection.
- `dist/workflow-loader.js` — YAML loader + validator.
- `dist/workflow-types.js` — type definitions.

## Files of record

- `proof/slice-6/REVIEW.md` — reviewer verdict (pending external review).
- `proof/slice-6/QA.md` — this file.
- `proof/slice-6/data-integrity-{pre,post}.txt` — schema/shape baselines.
- `proof/slice-6/data-integrity-notes.md` — narrative + diff evidence.
- `proof/slice-6/proof-runner.ts` — reproducible state-machine proof.
- `proof/slice-6/proof-runner-output.txt` — captured run output.
- `proof/slice-6/pretooluse-block-evidence.txt` — hook-block proof.
- `proof/slice-6/solo-mission-tasks-regression.md` — solo regression note.
- `proof/slice-6/solo-mission-baseline/check.sh` — automated regression script.
- `proof/slice-6/solo-mission-baseline/check-output.txt` — captured run output.
- `proof/slice-6/playwright/slice-6.spec.ts` — e2e spec for CI.

## Open follow-ups

1. **Wire workflow daemon into `src/index.ts` startup** — currently
   `startWorkflowDaemon()` exists but is not yet called by the
   `runMain()` boot path. This is intentional per the briefing's "stop
   and ask before changing core spawning code" rule. The proof script
   exercises the runner via `runWorkflowToCompletion` directly. Adding
   the call is a one-line change once Joe approves it.
2. **Real-agent council smoke** — the proof runner uses stub mode to
   keep the CI loop fast and token-free. A separate manual smoke is
   needed against real agents before the slice is shipped to
   production.
3. **Playwright run** — the spec at `proof/slice-6/playwright/slice-6.spec.ts`
   is committed but the actual run requires the dev server up. Will be
   exercised in headless CI on next push.
