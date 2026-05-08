# Slice 9 Wave 0 — Code Review

**Verdict: PENDING REVIEW**

**Worktree:** `.claude/worktrees/agent-a68b64f1e54664b48`
**Branch:** `worktree-agent-a68b64f1e54664b48`
**Implementation agent:** Claude Opus 4.7 (1M context)
**Review requested:** 2026-05-08

## Scope

Backend foundation for Slice 9 (Activity feed). Wave 1 has 3 parallel
agents waiting on this to ship cleanly:

  - mission_tasks schema additive migration: `source` + `source_id`
    columns (both nullable; legacy rows stay NULL).
  - Provenance plumbed through every queue point (webhook, log-tail,
    sqlite-poll, workflow-runner, mission-cli, dashboard manual create).
  - New `GET /api/activity` endpoint with filters + cursor pagination.
  - CF Access path rename: public ingress moves from
    `/api/watchers/webhook/<slug>` → `/api/hooks/<slug>`. Legacy alias
    kept. Supabase function defaults updated. CF Access bypass app
    domain updated via API.

## Files changed

| File | Change |
|---|---|
| `src/db.ts` | New columns + idempotent migration; `listActivity()` query helper; `getScheduledTask()` lookup. |
| `src/watchers.ts` | `runActions(actions, vars, src)` — third param carries `{ source, source_id }`; `queueMission()` accepts pair; log-tail / sqlite-poll callers pass it; nested `if-owned`/`if-unowned` recurse with same src. |
| `src/dashboard.ts` | Webhook handler refactored into `webhookIngressHandler`, mounted at `/api/hooks/:slug` (canonical) + legacy alias. New `GET /api/activity`. Displayed `webhook_url` strings updated. Manual create stamps `source='manual'`. |
| `src/workflow-runner.ts` | `recordMissionTaskForStage()` takes `runId`; escalation `createMissionTask` carries `source='workflow'` + `source_id=runId`. |
| `src/mission-cli.ts` | CLI create stamps `source='mission_cli'`. |
| `web/src/pages/Triggered.tsx` | Displayed URL preview shows `/api/hooks/<slug>`. |
| `supabase/functions/clawos-ceddi-bridge/index.ts` | Default URL → `/api/hooks/trading-monitor`. |
| `supabase/functions/clawos-ingest-bridge/index.ts` | Default URL → `/api/hooks/trading-monitor-ingest`. |
| `src/slice-9-activity.contract.test.ts` | 13 new contract tests. |
| `src/webhook.contract.test.ts` | One assertion updated to expect new canonical URL. |

## Non-goals (out of scope for Wave 0)

  - Activity UI page (Wave 1).
  - Removal of `/api/watchers/webhook/:slug` alias (post-Wave-0; needs
    every consumer migrated first).
  - Backfill of `source` for legacy rows (deliberately left NULL; UI
    surfaces them as "manual / unknown").
  - Supabase function deploy (main thread will do it after this lands).

## Self-review highlights for the reviewer

### A. Migration safety

- Both new columns are `TEXT` and nullable. No `NOT NULL DEFAULT` so the
  migration cannot silently rewrite legacy rows.
- Migration is implemented via the existing `addColumnIfMissing` helper
  → idempotent on re-runs.
- The new `idx_mission_source` index is created in `runMigrations()`
  (NOT in `createSchema`) because legacy DBs would crash if `createSchema`
  tried to index columns the migration hasn't added yet. This bug was
  caught by the idempotency test (run 3 — legacy DB). See
  `data-integrity-post.txt` for the proof of all three idempotency runs.

### B. Backwards compat at the function boundary

- `createMissionTask(...)` gains two trailing optional params, both
  defaulting to `null`. Every existing caller continues to compile and
  behaves identically.
- `queueMission(...)` (in `watchers.ts`) gains two trailing optional
  params; same default-to-null guarantee.
- `runActions(actions, vars)` gains an optional 3rd param `src`. All
  existing tests pass without modification (vi.mock signature continues
  to match because the param is optional).
- The legacy alias `/api/watchers/webhook/:slug` is mounted in
  parallel with `/api/hooks/:slug` — same handler, both routes resolve
  to one definition.

### C. /api/activity contract

- Sits AFTER the auth middleware (token or CF Access JWT required). NOT
  on the public webhook bypass path. Caller MUST authenticate.
- Allow-list validation on `source` and `status` filter values returns
  400 on unknown values rather than silently producing empty results.
- Cursor pagination uses `(created_at DESC, id DESC)` for stable
  ordering and decodes the cursor by looking up the row by id; if the
  cursor row was deleted (rare), the API treats it as "from the start"
  rather than 400, so eventual-consistency UIs don't break.
- Source-label join is per-request cached so a page of 50 rows from one
  workflow run hits the workflow_runs lookup once.
- `result_summary` is truncated to 200 chars; full result still
  reachable via `/api/mission/tasks/:id`.

### D. CF Access bypass app

- Domain updated `clawos.joetroyer.com/api/watchers/webhook/*` →
  `clawos.joetroyer.com/api/hooks/*`. Bypass policy + decision +
  app_launcher_visible left intact.
- `PATCH` returned `10405 Method not allowed for this auth scheme`. CF
  Access self_hosted apps need PUT with the full body; switched to PUT
  + verified via GET. Full transcript at `cf-access-update-output.txt`.

## Stop-and-ask conditions hit

  - **Discovery:** the brief said "Scheduler in src/scheduler.ts: when a
    cron fires and creates a mission_task, set source='scheduled'". In
    practice, `src/scheduler.ts` runs scheduled_tasks INLINE via
    `runAgent()` — no mission_task is ever created from a cron fire.
    Scheduled tasks and mission_tasks are separate concepts in this
    codebase. I left scheduler.ts unchanged. The `/api/activity` API
    still accepts `source=scheduled` as a filter value (returns 0 rows
    until/unless this codebase grows a cron→mission_task path). Surfaced
    here for the reviewer to confirm this is the right call rather than
    introducing a new code path that has no production caller.
  - **Discovery:** CF API `PATCH` rejected with `10405`; switched to
    PUT. Did not need to surface the perms issue because PUT worked with
    the existing token.
  - All other instructions followed verbatim.

## Tests

  - 13 new contract tests in `src/slice-9-activity.contract.test.ts` —
    all pass.
  - 1 existing webhook-list test updated to expect the new canonical URL
    in `webhook_url`.
  - Full suite: 555 pass, 4 skipped, 7 pre-existing failures (in
    `dashboard.contract.test.ts` and `schedule-cli.test.ts`, present on
    main pre-stash; unrelated to this slice).

## Acceptance criteria checklist

  - [x] `mission_tasks` schema has `source` + `source_id` TEXT columns,
        both nullable.
  - [x] Migration is idempotent (verified across 3 runs incl. a
        simulated legacy DB).
  - [x] Webhook queue point populates `source='webhook'`, `source_id=<slug>`.
  - [x] log-tail queue point populates `source='log-tail'`,
        `source_id=<watcher.name>`.
  - [x] sqlite-poll queue point populates `source='sqlite-poll'`,
        `source_id=<watcher.name>`.
  - [x] workflow-runner sequential + council stages populate
        `source='workflow'`, `source_id=<run_id>`. Escalation does too.
  - [x] mission-cli populates `source='mission_cli'`.
  - [x] Dashboard manual create populates `source='manual'`.
  - [x] `GET /api/activity` returns combined feed with all filters
        (source ×N, source_id, agent, status ×N, since, limit, cursor).
  - [x] `POST /api/hooks/:slug` accepts signed payloads.
  - [x] `POST /api/watchers/webhook/:slug` (alias) still accepts.
  - [x] CF Access bypass app domain updated to `/api/hooks/*`.
  - [x] Supabase function source defaults updated. NOT redeployed (per brief).
  - [x] All existing tests still pass.
  - [x] New contract tests committed.
