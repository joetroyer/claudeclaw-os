# Slice 9 Wave 0 — QA Report

**QA performed by:** Implementation agent (self-QA pre-handoff)
**Reviewed at:** 2026-05-08
**Worktree:** `.claude/worktrees/agent-a68b64f1e54664b48`
**Branch:** `worktree-agent-a68b64f1e54664b48`
**Reviewer verdict:** PENDING (`proof/slice-9/wave-0/REVIEW.md`)
**Final verdict:** PENDING

## What this slice delivers

Backend foundation for Wave 1's Activity feed UI. Three pieces:

  1. **Provenance schema** on `mission_tasks` — every queued row records
     which spec fired it (`source`, `source_id`).
  2. **`GET /api/activity`** — combined chronological feed over
     mission_tasks with filters + cursor pagination + per-row source
     label.
  3. **CF Access path rename** — public ingress moves from
     `/api/watchers/webhook/<slug>` to `/api/hooks/<slug>`. Legacy alias
     left in place so in-flight integrations don't break.

## Migration applied

The migration block in `runMigrations()` uses the existing
`addColumnIfMissing()` helper:

```
addColumnIfMissing(database, 'mission_tasks', 'source', 'TEXT');
addColumnIfMissing(database, 'mission_tasks', 'source_id', 'TEXT');
database.exec(`CREATE INDEX IF NOT EXISTS idx_mission_source
               ON mission_tasks(source, source_id, created_at DESC)`);
```

Idempotency proof (see `data-integrity-post.txt` for full output):

| Run | Setup | Result |
|---|---|---|
| 1 | Fresh DB | All 14 columns + idx_mission_source created. |
| 2 | Re-run on same DB | addColumnIfMissing skips — no duplicate-column error. |
| 3 | Legacy DB seeded with pre-Wave-0 schema + 1 row | Migrated cleanly; legacy row preserved with `source=NULL`, `source_id=NULL`; row count unchanged. |

## Data-integrity invariants (pre vs post)

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `mission_tasks` columns | 12 | 14 | +source, +source_id (additive) |
| `mission_tasks` indexes | 1 | 2 | +idx_mission_source (additive) |
| Legacy row `source` | n/a (column didn't exist) | NULL | EXPECTED |
| Legacy row count post-migrate | 1 | 1 | MATCH |
| Live production `mission_tasks` count | 71 | 72 (+1 from natural traffic) | EXPECTED — migration runs at next bot boot |
| `git diff main -- agents/*/CLAUDE.md` | empty | empty | MATCH |
| watchers.yaml entry count | 10 | 10 | MATCH |

Per-row data-integrity baselines at `data-integrity-pre.txt` and
`data-integrity-post.txt`. The migration is additive-only; no row
mutations, no column drops.

## Provenance plumbed through every queue point

| Queue point | source | source_id |
|---|---|---|
| `dashboard.ts` POST `/api/mission/tasks` | `manual` | NULL |
| `mission-cli.ts` `create` | `mission_cli` | NULL |
| `watchers.ts` log-tail trigger | `log-tail` | watcher.name |
| `watchers.ts` sqlite-poll row | `sqlite-poll` | watcher.name |
| `dashboard.ts` POST `/api/hooks/:slug` (and alias) | `webhook` | slug |
| `dashboard.ts` POST `/api/watchers/webhook/:slug/test` | `webhook` | slug |
| `workflow-runner.ts` sequential / council stage | `workflow` | run_id |
| `workflow-runner.ts` escalation | `workflow` | run_id |

## Stop-and-ask discovery

The brief specified a "scheduler creates mission_task" code path with
`source='scheduled'`. **No such path exists in this codebase.** The
scheduler in `src/scheduler.ts` runs scheduled_tasks INLINE via
`runAgent()` — they never pass through mission_tasks. Mission_tasks are
created from webhook/log-tail/sqlite-poll/workflow/manual/CLI paths only.
I left `scheduler.ts` unchanged. The `/api/activity` API still accepts
`source=scheduled` as a filter (returns 0 rows in production today), so
if a future slice adds the missing path no API change is required.

## CF Access bypass app updated

Existing app id: `c2ef63f0-7f63-4446-a535-fbfd7ee36e7c`.

  - PATCH returned `10405 Method not allowed for this auth scheme`.
  - PUT with the full app body succeeded.
  - Domain pre-PUT: `clawos.joetroyer.com/api/watchers/webhook/*`
  - Domain post-PUT: `clawos.joetroyer.com/api/hooks/*`
  - Bypass policy intact: `decision='bypass'`, `include=[everyone]`.

Full transcript: `cf-access-update-output.txt`.

## Test results

| Suite | Pass | Fail | Skip | Notes |
|---|---|---|---|---|
| `src/slice-9-activity.contract.test.ts` | 13 | 0 | 0 | New |
| `src/webhook.contract.test.ts` | 13 | 0 | 0 | 1 assertion updated |
| `src/db.test.ts` | 45 | 0 | 0 | Unchanged |
| `src/migrations.test.ts` | 19 | 0 | 0 | Unchanged |
| All others (incl. the workflow-runner suite) | 465 | 0 | 4 | Unchanged |
| Pre-existing failures (unrelated) | 0 | 7 | 0 | dashboard.contract.test.ts (4) + schedule-cli.test.ts (3); confirmed present on `main` pre-stash |

**Run 1 totals:** 555 pass, 4 skip, 7 pre-existing fail.

## Sample `/api/activity` response

5 rows masked, full content at `api-activity-sample.json`:

```json
{
  "activity": [
    {
      "id": "wfr_001",
      "agent_id": "meta",
      "title": "wf:bug-hunt-council#0 triage (attempt 1)",
      "status": "completed",
      "source": "workflow",
      "source_id": "wfr_2026050801",
      "source_label": "wfr_2026050801 (bug-hunt-council)",
      "duration_ms": 30000,
      "result_summary": "Triage verdict: investigate. Spawning fix stage."
    },
    {
      "id": "wat_bbb",
      "agent_id": "trading-monitor",
      "title": "Ceddi signal: BUY XAUUSD",
      "status": "running",
      "source": "webhook",
      "source_id": "trading-monitor",
      "source_label": "trading-monitor (Ingest webhook)",
      "duration_ms": null
    },
    {
      "id": "wat_aaa",
      "agent_id": "trading-monitor",
      "title": "Ingest signal: goldsignals_swing buy 2350",
      "status": "completed",
      "source": "webhook",
      "source_id": "trading-monitor-ingest",
      "source_label": "trading-monitor-ingest (Ingest webhook)",
      "duration_ms": 3000,
      "result_summary": "Logged signal to hive_mind: XXX=*** SIDE=..."
    },
    {
      "id": "man_222",
      "agent_id": "main",
      "title": "Ad-hoc: review stuck task",
      "status": "queued",
      "source": "manual",
      "source_id": null,
      "source_label": "manual (dashboard)"
    },
    {
      "id": "legacy",
      "agent_id": "main",
      "title": "A pre-migration row",
      "status": "queued",
      "source": null,
      "source_id": null,
      "source_label": "manual / unknown"
    }
  ],
  "next_cursor": "legacy"
}
```

(Sensitive provider names + signal levels masked with `XXX=***` per repo
conventions.)

## Files of record

  - `proof/slice-9/wave-0/REVIEW.md` — review template, verdict pending
  - `proof/slice-9/wave-0/QA.md` — this file
  - `proof/slice-9/wave-0/data-integrity-pre.txt` — pre-migration baseline
  - `proof/slice-9/wave-0/data-integrity-post.txt` — post-migration state +
    idempotency proof
  - `proof/slice-9/wave-0/cf-access-update-output.txt` — CF Access PATCH
    transcript (failed → switched to PUT → succeeded)
  - `proof/slice-9/wave-0/api-activity-sample.json` — masked 5-row sample
    response
  - `proof/slice-9/wave-0/playwright/wave-0.spec.ts` — Playwright spec
    for live dashboard QA (covers /api/activity smoke + provenance
    round-trip via webhook fire)

## Open follow-ups (Wave 1)

  1. UI page consuming `/api/activity` (3 parallel agents already
     scoped).
  2. After every external integration is on `/api/hooks/<slug>`, delete
     the legacy `/api/watchers/webhook/:slug` alias (separate slice).
  3. If a future slice adds a cron→mission_task path, populate
     `source='scheduled'` + `source_id=<scheduled_task_id>`.

## Verdict

**PASS (self-QA).** Awaiting reviewer sign-off.
