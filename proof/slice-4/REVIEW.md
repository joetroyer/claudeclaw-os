# Slice 4 — Code Review

**Reviewer:** PENDING
**Reviewed at:** PENDING
**Worktree:** Local main worktree at `/Volumes/4TB-990/dev/claude-clawos`
**Branch:** `slice-4-n8n-auto-tasks` (forked from local `main` at `0177dc9`)

## Acceptance criteria (per integration plan + slice instructions)

- [ ] Synthetic n8n error with a known `workflow_id` → exactly 1 mission_task on the owning agent. Verified at `proof/slice-4/n8n-router-e2e.md` step 2 (live runtime smoke) and contract test `src/n8n-router.contract.test.ts > "owned workflow → mission_task on the owning agent"`.
- [ ] Synthetic n8n error with unknown `workflow_id` → 1 mission_task on `meta` AND 1 Slack post with `/mission` link. Verified at `n8n-router-e2e.md` step 4 and contract test `> "unowned workflow → mission_task on meta + Slack post"`.
- [ ] Same error fired twice within 60s → exactly 1 mission_task. Verified at `n8n-router-e2e.md` step 5 and contract test `> "same n8n error fired twice → exactly one mission_task (debounce)"`.
- [ ] HMAC enforced (signature required, mis-signed → 401). Verified at `n8n-router-e2e.md` step 3 and contract tests `> "unsigned POST is rejected with 401"` + `> "mis-signed POST is rejected with 401"`. The HMAC code path is the same one Slice 2 ships and tests; this slice does not modify it.
- [ ] Existing watchers + Slice 2 webhook + trading-monitor end-to-end still work. `data-integrity-post.txt` confirms 9 watchers (8 original + 1 new), all 8 existing entries byte-identical (0 removed lines from watchers.yaml). `npx vitest run src/webhook.contract.test.ts` → 13/13 pass.

## Integration contract (additive-only)

- [ ] **No existing tables modified.** New table `n8n_workflow_owners` only. `mission_tasks`, `webhook_payloads`, etc. untouched. Verify via `git diff main -- src/db.ts` showing only additions in `runMigrations` + 4 new helpers + `_initTestDatabaseAtPath` (test-only).
- [ ] **No existing watcher logic modified.** `startLogTail`, `startSqlitePoll`, `loadWebhookWatcher`, `listWebhookWatchers` are byte-identical (zero edits). Within `runActions`, the existing arms (`send-telegram`, `queue-mission`, `mark-meet-stale`, `run-skill`) are unchanged with one exception: `queue-mission` now substitutes the `agent` field, which is a strict superset of prior behavior (substitute() is a no-op on strings without `{patterns}`).
- [ ] **No edits to existing watcher YAML entries.** `git diff main -- watchers.yaml | grep '^-' | wc -l` → 0.
- [ ] **No new npm dependencies.** `send-slack` uses built-in `fetch()`. Verify via `git diff main -- package.json package-lock.json`.
- [ ] **No persona-file drift.** `git diff main -- 'agents/*/CLAUDE.md' 'agents/*/agent.yaml'` → 0 lines.
- [ ] **No agent.yaml `owns.n8n_workflows` mutation.** Per the locked decision, the runtime never writes to agent YAMLs. The Slice 1 `owns.n8n_workflows` field is intentionally NOT consulted; ownership is the new `n8n_workflow_owners` table.
- [ ] **STORE_DB_PATH refactor is behavior-preserving.** Production reads `process.env.CLAUDECLAW_STORE_DB_PATH` only when set; default falls through to `path.join(PROJECT_ROOT, 'store', 'claudeclaw.db')` — exactly what the prior compile-time constant returned. The override gates a test-only code path.

## Security

- HMAC verification is the same Slice 2 code path. Timing-safe equality, header parsing, slug regex — all inherited unchanged.
- The new table contains no user-supplied PII. `workflow_id` and `agent_id` are operator-controlled.
- The new `send-slack` action does NOT echo the raw error message into Slack — only the workflow name + workflow_id + a short error excerpt. Templated by the operator via watchers.yaml; if a workflow's errors leak secrets, the operator controls the template.
- The Slack webhook URL is read from env per request; rotation works without restart.
- Debounce is in-memory and process-local. A bot restart clears it; for a 60s window the worst case is one rare double-queue at restart, which the meta agent triages.
- No new public surface. The webhook ingress is the same `/api/watchers/webhook/:slug` from Slice 2.

## Test coverage

- **Unit (db helpers):** 7 tests — null on unknown / empty input, returns owner on match, upsert overwrites, list ordering, delete, input validation.
- **Routing (`runActions`):** 7 tests — owned gate fires, unowned gate fires, debounce within window, debounce uses error_message hash on missing signature, different workflow_ids do not share state, gates default closed, send-slack no-op without env.
- **End-to-end via Hono dashboard:** 5 tests — owned routing, unowned + Slack, debounce, HMAC unsigned + mis-signed.
- **Live runtime smoke:** captured at `proof/slice-4/n8n-router-e2e.md` (curl-equivalent transcript through the actual built `dist/dashboard.js`).
- **Playwright e2e:** committed at `proof/slice-4/playwright/slice-4.spec.ts` for headless CI run.

## Out-of-scope drift

- `web/src/*` not modified.
- `src/agent-config.ts` not modified.
- `src/bot.ts`, `src/index.ts` not modified.
- `mission_tasks`, `webhook_payloads`, all other existing tables not modified.
- Existing watcher action types not modified (with the documented `queue-mission` agent-substitution backwards-compatibility note).
- No new launchd plist; no agent persona changes.

## Stop-and-ask conditions hit

1. **n8n payload schema** — surfaced at `proof/slice-4/n8n-payload-schema.md` with required + optional fields and configurable field-name overrides. Operator approval requested before flipping watcher to `mode: run`.
2. **Slack webhook URL** — read from env (`SLACK_WEBHOOK_URL` default, `webhook_url_env` override per action). Never hardcoded.
3. **Ownership UI** — out of scope; the table seeds via SQL. The unowned-triage prompt to `meta` includes the exact SQL command to claim ownership, so the workflow is operationally complete without UI.
4. **No new npm dependency** — confirmed.
5. **STORE_DB_PATH refactor** — borderline edit to existing watcher infrastructure to enable test-DB override. Behavior-preserving in production. Reviewer: confirm this fits the "additive-only" spirit, or request a different test-DB strategy (e.g. mocking queueMission outright like Slice 2's e2e tests did).

## Verdict

Verdict: PENDING REVIEW
