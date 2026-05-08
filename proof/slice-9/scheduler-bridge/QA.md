# QA — Slice 9 Scheduler → mission_tasks Provenance Bridge

## Summary of change

When a scheduled task (cron) fires, the scheduler now writes a row into
`mission_tasks` with `source='scheduled'` and
`source_id=<scheduled_task.id>` so it appears in the Activity feed
(`/api/activity?source=scheduled`). Without this, scheduled fires were
invisible to the feed because the scheduler runs `runAgent` inline and
never queued a mission task.

## What to verify post-merge

### Automated (already covered)

```bash
npx tsc --noEmit                    # 0 errors
npx vitest run src/scheduler.test.ts # 33/33 pass (incl. 6 new bridge cases)
npx vitest run src/                  # 571 pass; 11 known pre-existing fails/skips
```

### Synthetic data-integrity proof

A throwaway driver lives at `data-integrity.ts`. It uses the in-memory
test DB so it is safe to run on a developer machine without touching
`store/claudeclaw.db`:

```bash
cd <worktree>
npx tsx proof/slice-9/scheduler-bridge/data-integrity.ts --pre  > proof/slice-9/scheduler-bridge/data-integrity-pre.txt
npx tsx proof/slice-9/scheduler-bridge/data-integrity.ts        > proof/slice-9/scheduler-bridge/data-integrity-post.txt
```

The pre file shows `mission_tasks count: 0`. The post file shows
`count: 1` with a row whose `source='scheduled'` and
`source_id='proof-cron'`. Both files are committed.

### Manual end-to-end (for staging or dev install — DO NOT run in prod)

The scheduler bridge writes a real row to `store/claudeclaw.db` when a
real cron task fires. To verify against a running install without
waiting for the next cron tick:

1. Pick (or create) a cheap scheduled task:

   ```bash
   PROJECT_ROOT=$(git rev-parse --show-toplevel)
   node "$PROJECT_ROOT/dist/schedule-cli.js" create "echo hello" "* * * * *"
   # capture the printed task id, e.g. "ab12cd34"
   ```

2. Wait one minute for the scheduler to fire it (or restart the agent
   service to force-pick due tasks).

3. Confirm the bridge row landed:

   ```bash
   sqlite3 "$PROJECT_ROOT/store/claudeclaw.db" \
     "SELECT id, status, source, source_id, created_by, silent_start, silent_result
      FROM mission_tasks WHERE source = 'scheduled' ORDER BY created_at DESC LIMIT 5;"
   ```

   Expect a row with `source=scheduled`, `source_id=<your task id>`,
   `created_by=scheduler`, status `completed` (or `failed` if the run
   surfaced an error).

4. Hit the Activity API with the dashboard token:

   ```bash
   curl -s -H "x-clawos-token: $DASHBOARD_TOKEN" \
     "http://localhost:$DASHBOARD_PORT/api/activity?source=scheduled" | jq '.activity[]'
   ```

   Expect at least one entry with `source: "scheduled"` and a
   `source_label` like `<task-id> (echo hello)`.

5. Tear-down:

   ```bash
   node "$PROJECT_ROOT/dist/schedule-cli.js" delete <task-id>
   ```

## What did NOT change

- `runAgent` is untouched.
- No new tables.
- `scheduled_tasks` schema unchanged (`silent_start` / `silent_result`
  already exist from a prior slice).
- `/api/activity` endpoint unchanged (Wave 0 already accepts
  `source=scheduled`).
- `src/watchers.ts` unchanged.

## Risks / known limitations

- Legacy scheduled fires from before this slice merged have no
  `mission_tasks` row. The Activity feed treats those as missing
  (consistent with Wave 0's "legacy rows stay NULL" decision).
- Provenance write failures (rare — DB locked / migrating) are caught
  and logged; the user's scheduled task itself still runs. This is by
  design so a feed-side issue cannot break a real cron job.
