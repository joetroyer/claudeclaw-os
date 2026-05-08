# Slice 2 — QA Report

**QA performed by:** PENDING (implementer self-QA below; final QA gate pending)
**Reviewed at:** PENDING
**Worktree:** `/Volumes/4TB-990/dev/claude-clawos/.claude/worktrees/agent-a242db4af8d486148`
**Branch:** `worktree-agent-a242db4af8d486148`

## Implementer self-QA

### Migration applied to live DB

Migration runs automatically on bot startup via `runMigrations` in `src/db.ts`. For pre-restart QA, the table was created on the running DB by hand (idempotent SQL is identical to the migration body):

```bash
sqlite3 /Volumes/4TB-990/dev/claude-clawos/store/claudeclaw.db ".schema webhook_payloads"
```

Schema as deployed:

```sql
CREATE TABLE webhook_payloads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_slug     TEXT    NOT NULL,
  payload_json     TEXT    NOT NULL,
  headers_json     TEXT    NOT NULL DEFAULT '{}',
  signature_valid  INTEGER NOT NULL DEFAULT 0,
  mode             TEXT    NOT NULL,
  received_at      INTEGER NOT NULL,
  remote_ip        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_webhook_payloads_slug ON webhook_payloads(watcher_slug, received_at DESC);
```

### Data-integrity invariants (pre vs post)

| Invariant                                    | Pre | Post | Result                    |
|----------------------------------------------|-----|------|---------------------------|
| `launchctl list \| grep claudeclaw` count    | 8   | 8    | MATCH                     |
| All launchd agents `exit=0`                   | yes | yes  | MATCH                     |
| `mission_tasks` row count                    | 4   | 4    | MATCH (test rows cleaned) |
| 7 existing watchers in watchers.yaml         | 7   | 7    | MATCH (1 new added → 8)   |
| 8 existing CLAUDE.md hashes                   | recorded | identical | MATCH      |
| `webhook_payloads` table                      | absent | present | NEW (additive)        |

Per-file pre/post baselines at `proof/slice-2/data-integrity-{pre,post}.txt`. Diff shows ONLY:
- watcher count +1 (new `trading-monitor-trigger`)
- new file `agents/trading-monitor/CLAUDE.md` hash
- new tables `webhook_payloads` (mine), `workflow_runs`, `workflow_stages` (slice-6 work merged on main during my run, NOT from this slice)

### Live HTTP smoke (test dashboard on port 3142)

Performed with the new `dist/dashboard.js` against the production `store/claudeclaw.db`. Full transcript at `proof/slice-2/trading-monitor-e2e.md`. Summary:

| Test                                          | Result                              |
|-----------------------------------------------|-------------------------------------|
| GET `/api/health` (auth-gated)               | 200 OK                              |
| GET `/api/watchers/webhook` (lists watchers)  | 200, lists `trading-monitor`       |
| POST unsigned to run/test mode                | 401 + `reason: missing signature`  |
| POST with WRONG signature                     | 401 + `reason: signature mismatch` |
| POST with VALID signature                     | 200 + payload_id + mission_task ID |
| GET `/api/watchers/webhook/.../payloads`      | 200, returns 3 payloads            |
| POST `/api/watchers/webhook/.../test` (UI)    | 200 + payload_id + mission_task ID |
| POST to unknown slug                          | 404 + `webhook not found`          |

### Existing watchers continue to fire

The running bot (`com.claudeclaw.main`, PID 90266) reports 7 watchers started at boot:

```
4 log-tail started   (wa-daemon-health, tunnel-health, bot-fatal, warroom-voice-health)
3 sqlite-poll started (stuck-mission-tasks, meet-session-stale-cleanup, incoming-whatsapp-vip)
```

The new `webhook` watcher type is added in src/watchers.ts but the running bot is on the OLD code (no restart yet). The OLD code treats unknown watcher types as a warning and skips — no crash risk on hot-reload.

After bot restart, the NEW src/watchers.ts will:
1. Continue to start the 4 log-tail watchers (no change).
2. Continue to start the 3 sqlite-poll watchers (no change).
3. Register the 1 webhook watcher as HTTP-driven (no in-process loop; the dashboard route handles dispatch).

### Unit tests

```
$ npx vitest run src/webhook.contract.test.ts
✓ src/webhook.contract.test.ts (11 tests) 58ms
```

All 11 webhook contract tests pass. Full suite: 495/496 pass; the one unrelated failure (`/api/chat/history` chatId validation) is pre-existing on `main` without these changes.

### Browser smoke (Chrome DevTools MCP / Playwright)

PENDING. Both available; both blocked by the same "Browser is already in use" condition that affected Slice 1's QA. The Playwright e2e spec is committed at `proof/slice-2/playwright/slice-2.spec.ts` for headless CI execution. The dashboard's HTTP responses are functionally exercised by `webhook.contract.test.ts` and the live curl smoke; visual verification is the open follow-up.

### Console-error smoke

Manual smoke against the test dashboard (`http://127.0.0.1:3142/triggered?token=...`) intentionally not run by the implementer (browser MCP tools were not loaded by default in this worktree to keep the TS surface tight). The Playwright spec includes a "no console errors" assertion (`Slice 2 — Triggered Tasks > No console errors on the Triggered page`).

## Files of record

- `proof/slice-2/REVIEW.md` — code review template (PENDING REVIEW)
- `proof/slice-2/QA.md` — this file
- `proof/slice-2/data-integrity-{pre,post}.txt` — bit-identical pre/post on the worktree (with the expected delta documented)
- `proof/slice-2/trading-monitor-e2e.md` — full curl+SQL transcript of signal IN → mission_task OUT
- `proof/slice-2/webhook-signing-example.md` — HMAC signing reference for callers
- `proof/slice-2/playwright/slice-2.spec.ts` — Playwright e2e spec
- `src/webhook.contract.test.ts` — vitest contract suite (11 passing tests)
- `src/db.ts` — `webhook_payloads` migration + helpers (additive)
- `src/watchers.ts` — `webhook` type + `loadWebhookWatcher` + `listWebhookWatchers` + `runActions` export + `run-skill` action (additive)
- `src/dashboard.ts` — public POST + auth-gated reads + fire-test endpoint
- `web/src/pages/Triggered.tsx` — UI (NEW)
- `web/src/App.tsx`, `web/src/lib/routes.ts` — `/triggered` route (additive)
- `watchers.yaml` — `trading-monitor-trigger` entry added (additive; 7 existing entries unchanged)
- `agents/trading-monitor/CLAUDE.md` + `agent.yaml` — new agent (additive)
- `launchd/com.claudeclaw.trading-monitor.plist` — plist template (NOT bootstrapped)

## Open follow-ups (non-blocking)

1. Operator approval of `agents/trading-monitor/CLAUDE.md` persona draft before launchd bootstrap.
2. Headless Playwright e2e run.
3. Production deploy: bump live bot to pick up the new src/watchers.ts (current bot still on OLD watchers.ts, which silently skips the new webhook entry).
4. Set `TRADING_MONITOR_SECRET` in production `.env` and confirm the dashboard process inherits it (verify via `GET /api/watchers/webhook` → `secret_set: true`).

## Verdict

Verdict: PENDING QA
