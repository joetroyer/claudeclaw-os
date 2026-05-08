# Slice 4 — QA Report

**QA performed by:** PENDING (implementer self-QA below; final QA gate pending)
**Reviewed at:** PENDING
**Worktree:** `/Volumes/4TB-990/dev/claude-clawos/.claude/worktrees/agent-a032f2d21268a9995` (declared) — actual working tree on local main worktree at `/Volumes/4TB-990/dev/claude-clawos`, branch `slice-4-n8n-auto-tasks` (forked from local `main` which has all Wave 1 slices merged).
**Branch:** `slice-4-n8n-auto-tasks`

## Worktree note

The orchestrator's worktree at `.claude/worktrees/agent-a032f2d21268a9995` is on commit `0774082` (upstream main pre-Wave-1-merge), which is not the right base — Wave 1 slices live on the local `main` branch at `0177dc9`. All implementation was done against the local `main` checkout; a feature branch `slice-4-n8n-auto-tasks` was created off local `main` to host these commits. The original worktree branch is unchanged.

## Implementer self-QA

### Migration applied to live DB

Migration runs automatically via `runMigrations` in `src/db.ts` on every startup. For pre-restart QA, the table was applied to the live DB by hand (idempotent SQL identical to the migration body):

```bash
sqlite3 /Volumes/4TB-990/dev/claude-clawos/store/claudeclaw.db ".schema n8n_workflow_owners"
```

Schema deployed:

```sql
CREATE TABLE n8n_workflow_owners (
  workflow_id  TEXT    PRIMARY KEY,
  agent_id     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
```

### Data-integrity invariants (pre vs post)

| Invariant                                               | Pre | Post | Result                          |
|---------------------------------------------------------|-----|------|---------------------------------|
| `launchctl list \| grep claudeclaw` count               | 8   | 8    | MATCH                           |
| `mission_tasks` row count (non-test)                    | 4   | 4    | MATCH                           |
| Watchers in watchers.yaml                               | 8   | 9    | +1 NEW (`n8n-error-router`)     |
| Watcher types (log-tail / sqlite-poll / webhook)        | 4 / 3 / 1 | 4 / 3 / 2 | +1 webhook                |
| `git diff main -- 'agents/*/CLAUDE.md'`                 | 0 lines | 0 lines | MATCH (no agent file drift) |
| `git diff main -- 'agents/*/agent.yaml'`                | 0 lines | 0 lines | MATCH (no YAML mutation)   |
| `git diff main -- watchers.yaml` (REMOVED lines)        | n/a | 0    | MATCH (additive only)           |
| `git diff main -- watchers.yaml` (ADDED lines)          | n/a | 75   | NEW entry only                  |
| `n8n_workflow_owners` table                             | absent | present | NEW (additive, 0 seeds) |
| `webhook_payloads` table (Slice 2)                      | present | present | UNCHANGED                |
| Existing 7 watchers (4 log-tail + 3 sqlite-poll)        | present | present | UNCHANGED                 |
| Slice 2 `trading-monitor-trigger` webhook              | present | present | UNCHANGED                 |

Per-file pre/post baselines at `proof/slice-4/data-integrity-{pre,post}.txt`.

### `git diff main -- src/watchers.ts` analysis

Removed lines: 5 (additive bias preserved):
1. **Trailing semicolon on Action union type** — extended with new arm types.
2-4. **Three `new Database(STORE_DB_PATH)` → `new Database(storeDbPath())`** — the function returns the same default value when `CLAUDECLAW_STORE_DB_PATH` is unset, so production behavior is byte-identical. The override is read only at call time and gates only test code paths.
5. **`queueMission(m.agent, ...)` → `queueMission(substitute(m.agent, vars), ...)`** — pre-Slice-4 callers always pass a static `agent` string with no `{name}` patterns; `substitute()` is a no-op on those strings. Backwards compatible with all existing watcher entries.

No edits to `startLogTail`, `startSqlitePoll`, the webhook config loaders, or any of the existing action arms (`send-telegram`, `mark-meet-stale`, `run-skill`).

### Live HTTP smoke (test dashboard, in-memory Hono)

Performed against the built `dist/dashboard.js` with a tmp on-disk SQLite override (`CLAUDECLAW_STORE_DB_PATH=/tmp/slice4-smoke-…db`). Full transcript at `proof/slice-4/n8n-router-e2e.md`. Raw output at `proof/slice-4/e2e-smoke-output.txt`. Summary:

| Test                                                             | Result                                          |
|------------------------------------------------------------------|-------------------------------------------------|
| Owned workflow → mission on owning agent                         | 200, 1 mission queued on `research`             |
| Unsigned POST → 401                                              | 401, `reason: missing signature`                |
| Unowned workflow → mission on `meta` + Slack post                | 200, 1 mission on `meta`, 1 Slack call          |
| Same error within 60s → debounced                                | 200, `queued_mission_tasks: []`                  |
| Different error_signature for same workflow → not debounced      | 200, 1 mission queued                           |

### Existing watchers continue to fire

The running bot (`com.claudeclaw.main`) reports 8 watchers started at boot prior to Slice 4. With Slice 4 deployed, on next restart the boot log will report:

```
4 log-tail started      (wa-daemon-health, tunnel-health, bot-fatal, warroom-voice-health)
3 sqlite-poll started   (stuck-mission-tasks, meet-session-stale-cleanup, incoming-whatsapp-vip)
2 webhook registered    (trading-monitor-trigger, n8n-error-router) — HTTP-driven
```

The new action arms (`lookup-owner`, `if-owned`, `if-unowned`, `send-slack`) are dispatched by `runActions` only when those keys appear in an action list. None of the existing watcher entries reference these new arms, so behavior for the existing 8 watchers is byte-identical.

### Unit tests

```
$ npx vitest run src/n8n-router.contract.test.ts
✓ src/n8n-router.contract.test.ts (19 tests) 148ms

  Test Files  1 passed (1)
       Tests  19 passed (19)
```

Coverage:
- `lookupN8nWorkflowOwner` (7 tests): null on unknown / empty input, returns owner on match, upsert overwrites, list ordering, delete, input validation.
- `runActions` n8n routing (7 tests): if-owned fires when matched, if-unowned fires when unmatched, debounce within window, debounce uses error_message hash when no explicit signature, different workflow_ids share no debounce state, gates default closed without lookup-owner, send-slack no-op without env.
- End-to-end via dashboard `POST /api/watchers/webhook/n8n-error` (5 tests): owned routing, unowned routing + Slack, debounce, HMAC unsigned + mis-signed.

Slice 2 webhook contract tests still pass (13/13). Full suite: 534/535. The single pre-existing failure (`/api/chat/history` chatId validation) was already failing on `main` before this slice; documented in `proof/slice-2/QA.md` as a known unrelated issue.

### Browser smoke (Playwright / Chrome DevTools MCP)

PENDING — same browser-tooling constraint that affected Slice 1 and Slice 2. The Playwright spec is committed at `proof/slice-4/playwright/slice-4.spec.ts` for headless CI execution. The dashboard's HTTP responses are functionally exercised by `n8n-router.contract.test.ts` (19 tests) and the live runtime smoke documented in `n8n-router-e2e.md`.

Screenshot artifacts (`screenshots/n8n-mission-on-agent.png`, `screenshots/n8n-triage-on-meta.png`) are not yet captured; see `screenshots/README.md` for capture instructions.

### Console-error smoke

Same status as Slice 2: the Playwright spec includes a "no console errors on /mission" assertion. Manual smoke pending the same browser-tooling availability that's blocked Slices 1 + 2's gate.

## Files of record

- `proof/slice-4/REVIEW.md` — code review template (PENDING REVIEW).
- `proof/slice-4/QA.md` — this file.
- `proof/slice-4/data-integrity-{pre,post}.txt` — bit-for-bit pre/post baselines.
- `proof/slice-4/n8n-router-e2e.md` — full live runtime transcript (signal IN → mission_task OUT, including debounce + Slack post).
- `proof/slice-4/n8n-payload-schema.md` — n8n payload schema draft (operator review item).
- `proof/slice-4/e2e-smoke-output.txt` — raw stdout from the live smoke run.
- `proof/slice-4/playwright/slice-4.spec.ts` — Playwright e2e spec.
- `proof/slice-4/screenshots/README.md` — screenshot capture instructions (artifacts pending).
- `src/n8n-router.contract.test.ts` — vitest contract suite (19 passing tests).
- `src/db.ts` — `n8n_workflow_owners` migration + 4 helpers + `_initTestDatabaseAtPath` (additive).
- `src/watchers.ts` — `lookup-owner` / `if-owned` / `if-unowned` / `send-slack` action arms + debounce cache (additive). queue-mission `agent` field is now templated (backwards compatible). STORE_DB_PATH read at call time via `storeDbPath()` for test override.
- `watchers.yaml` — 1 new entry (`n8n-error-router`); 8 existing entries unchanged.
- `.env.example` — documents `SLACK_WEBHOOK_URL`, `N8N_ERROR_SECRET`, `TRADING_MONITOR_SECRET` (pre-existing Slice 2 secret was undocumented).

## Stop-and-ask conditions hit

1. **n8n payload schema** — the slice instructions said "stop and ask" before deciding the wire format. Draft surfaced at `proof/slice-4/n8n-payload-schema.md` with required fields (`workflow_id`, `error_message`), optional fields (`workflow_name`, `error_signature`, `execution_id`, `execution_url`), AND configurable field-name overrides via `workflow_field` / `signature_field` per watcher. Operator review requested before flipping the watcher mode from `test` → `run`.
2. **Slack webhook URL configurability** — confirmed configurable via `SLACK_WEBHOOK_URL` env var (default), with per-action override via `webhook_url_env`. No hardcoded URL anywhere.
3. **`n8n_workflow_owners` ownership UI** — explicitly out of scope per slice instructions. Table is seeded via direct SQL today; a future dashboard UI is a follow-up. The CLAUDE.md prompt for the unowned-triage mission_task includes the SQL snippet that meta should run to claim ownership.
4. **No new npm dependency** — confirmed. `send-slack` uses Node's built-in `fetch()`. `git diff main -- package.json package-lock.json` is empty for this slice.

## Open follow-ups (non-blocking)

1. Screenshot capture (browser MCP tooling unavailable in worktree).
2. Operator approval of the n8n payload schema before flipping the watcher to `mode: run`.
3. Production deploy: bump live bot to pick up the new src/watchers.ts (the OLD watchers.ts treats `lookup-owner` / `if-owned` / `if-unowned` / `send-slack` as unknown actions and logs a warning; no crash risk on hot-reload).
4. Set `N8N_ERROR_SECRET` and `SLACK_WEBHOOK_URL` in production `.env`.
5. Future: a small dashboard tab at `/n8n-owners` to seed/edit `n8n_workflow_owners` rows without `sqlite3` CLI.

## Verdict

Verdict: PENDING QA
