# Slice 9 — Scheduler → mission_tasks Provenance Bridge

**Verdict: PENDING REVIEW**

**Worktree:** `.claude/worktrees/agent-a75d2496d58b82bf7`
**Branch:** `worktree-agent-a75d2496d58b82bf7`
**Implementation agent:** Claude Opus 4.7 (1M context)

## Scope

Closes the gap surfaced by Wave 0's stop-and-ask:

> "the brief said 'Scheduler in src/scheduler.ts: when a cron fires and creates
> a mission_task, set source='scheduled''. In practice, src/scheduler.ts runs
> scheduled_tasks INLINE via runAgent() — no mission_task is ever created from
> a cron fire. […] The /api/activity API still accepts source=scheduled as a
> filter value (returns 0 rows until/unless this codebase grows a
> cron→mission_task path)."

This wave grows that path.

When the scheduler fires a cron task, it now also writes a `mission_tasks`
row stamped with `source='scheduled'` + `source_id=<scheduled_task.id>`,
flips it to `running`, and finalises it (`completed` / `failed`) when the
inline `runAgent` call finishes. `silent_start` / `silent_result` flags
from the scheduled task are propagated.

## Files changed

| File | Change |
|---|---|
| `src/db.ts` | `markMissionTaskRunning(id)` — small helper to flip a mission_task row directly to `running` without going through `claimNextMissionTask` (which is for the queue/poll worker, not for inline-executed scheduler rows). |
| `src/scheduler.ts` | Per-task body extracted into `executeScheduledTask(task, nextRun, runner?, send?)`. Production callers stay unchanged (defaults resolve to the real `runAgent` and the registered Telegram sender). The new function emits the provenance row before invoking `runner`, then completes/fails it after. |
| `src/scheduler.test.ts` | 6 new vitest cases covering the bridge: success, runAgent throws, runAgent aborted/timeout, silent_start/silent_result propagation, agent isolation, and side-by-side scheduled_tasks state-machine update. Existing 27 tests untouched. |
| `proof/slice-9/scheduler-bridge/` | This proof bundle (REVIEW, QA, data-integrity-pre.txt, data-integrity-post.txt, data-integrity.ts driver). |

## Non-goals

- No change to `runAgent` itself.
- No new tables.
- No `scheduled_tasks` schema changes — `silent_start` / `silent_result`
  already exist on that table from prior slices.
- No change to `/api/activity` (Wave 0 already supports
  `source='scheduled'`).
- No change to `src/watchers.ts`.
- No backfill for historical scheduled fires; only fires from this point
  onward populate `mission_tasks` rows.

## Self-review highlights

### A. Backwards compatibility

- `executeScheduledTask` accepts optional `runner` and `send` parameters
  with defaults that resolve to the real `runAgent` import and the
  module-level `sender` populated by `initScheduler`. Production code
  paths through `runDueTasks() → messageQueue.enqueue(...)` invoke it
  with two args, identical to the prior inline behaviour.
- `markMissionTaskRunning` is additive; nothing else reads or writes the
  `running` state for scheduler-created rows.
- `createMissionTask` already accepted `silent_start` / `silent_result` /
  `source` / `source_id` after Slice 9 Wave 0 — no signature change here.

### B. Race avoidance with the mission worker

- The scheduler is its own agent's mission worker (`claimNextMissionTask`
  poll inside `runDueMissionTasks`). If the bridge inserted a row in
  `queued` state and waited a tick, the same process's next 60s poll
  could re-claim it as a regular mission task and run `runAgent` on the
  same prompt twice.
- We avoid this by calling `markMissionTaskRunning` immediately after
  `createMissionTask` (within the same JS turn). The poll's
  `claimNextMissionTask` filters on `status = 'queued'` so the row is
  already past it by the time the next tick fires.

### C. Failure isolation

- The provenance writes (`createMissionTask` / `markMissionTaskRunning`
  and the terminal `completeMissionTask`) are wrapped in try/catch with
  `logger.warn`. If the DB is full / locked / migrating, the user's
  scheduled task still runs and reports normally; we just lose one
  Activity-feed row.
- This matches the existing pattern in `completeMissionTask` itself,
  which already swallows hive_mind insert errors so a hive-side problem
  doesn't tank a real mission.

### D. Test boundaries

- Tests directly invoke `executeScheduledTask` rather than waiting for
  the 60s `setInterval` to fire. The runner is stubbed via
  `vi.fn().mockResolvedValue(...)` so we never spin up a real Claude
  process; the sender is a no-op so we never touch grammy / Telegram.
- The DB is the same in-memory SQLite used by the existing 27 cases —
  schema parity guaranteed.

## Acceptance checklist

- [x] Scheduler emits a `mission_tasks` row with
      `source='scheduled'` / `source_id=<scheduled_task.id>` per cron
      fire (verified in proof artifact + test suite).
- [x] `silent_start` and `silent_result` from `scheduled_tasks`
      propagate onto the `mission_tasks` row.
- [x] Successful runs set `status='completed'` and `result=<text>`.
- [x] Thrown errors set `status='failed'` and `error=<message>`.
- [x] Aborted/timed-out runs set `status='failed'` with the timeout
      message.
- [x] `assigned_agent` matches the scheduled task's `agent_id`
      (multi-agent isolation preserved).
- [x] `scheduled_tasks` state machine still updates correctly
      (`last_status`, `last_result`, `next_run`).
- [x] `npx tsc --noEmit` clean.
- [x] `npx vitest run src/scheduler.test.ts` — 33/33 pass (27 existing
      + 6 new).
- [x] `npx vitest run src/` — 571/582 pass; the 11 leftovers are 7
      pre-existing failures in `dashboard.contract.test.ts` /
      `schedule-cli.test.ts` (confirmed unchanged by reverting our
      diff and re-running) and 4 `.skip`'d cases unrelated to this slice.

## Open follow-ups

- (Out of scope here) Backfill: legacy scheduled fires before this slice
  have no `mission_tasks` rows. Activity feed treats them as missing.
  This is acceptable per Wave 0's "legacy rows stay NULL" stance.
- (Out of scope here) The same pattern could be applied to
  `runDueMissionTasks` if/when it grows a non-mission-table source path,
  but today mission tasks already self-source via `created_by`/`source`
  set at queue time.
