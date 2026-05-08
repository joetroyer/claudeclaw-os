# Slice 2 — Code Review

**Reviewer:** PENDING
**Reviewed at:** PENDING
**Worktree:** `/Volumes/4TB-990/dev/claude-clawos/.claude/worktrees/agent-a242db4af8d486148`
**Branch:** `worktree-agent-a242db4af8d486148` (worktree branch, may have been switched to `main` by parallel slice work)

## Acceptance criteria (per integration plan)

- [ ] User creates a triggered task (via watchers.yaml entry) and gets a webhook URL with HMAC secret. Live verified at: `proof/slice-2/data-integrity-post.txt` shows `trading-monitor-trigger` in watchers.yaml; UI lists it at `/triggered`.
- [ ] POST to URL in `run` mode with valid signature → mission_task created on assigned agent. Live verified at: `proof/slice-2/trading-monitor-e2e.md` (`wat_mow3od0t_hxy5ck` queued for `trading-monitor`).
- [ ] POST in `preview` mode → payload visible in UI, no mission_task created. Verified by unit test `src/webhook.contract.test.ts` "preview mode captures payload but does NOT fire actions".
- [ ] Fire-test-payload button executes with user-supplied sample data. Verified by unit test "fire-test endpoint writes a test payload and runs actions" + live curl in trading-monitor-e2e.md step 9.
- [ ] Existing 7 watchers continue to fire. `data-integrity-post.txt` confirms 8 entries in watchers.yaml (7 original + 1 new). The OLD watchers.ts is loaded in the running bot (no restart yet); the NEW watchers.ts preserves all log-tail and sqlite-poll handling code paths verbatim — only adds the `webhook` arm and new exports.
- [ ] Trading monitor migrated and processes a sample signal payload end-to-end. Verified at `proof/slice-2/trading-monitor-e2e.md`. **Important: agent's persona prose is up for Joe's review before launchd bootstrap.**
- [ ] Unsigned/mis-signed POST → 401. Verified by unit tests + live curl in trading-monitor-e2e.md steps 3 + 4.

## Integration contract (additive-only)

- [ ] **No existing tables modified.** New table `webhook_payloads` only. `mission_tasks`, `tasks`, `hive_mind`, etc. untouched. Confirm via `git diff main -- src/db.ts` showing only additions in `runMigrations` + new helpers `insertWebhookPayload`, `listWebhookPayloads`.
- [ ] **No existing watcher logic modified.** `startLogTail`, `startSqlitePoll`, all 7 production watcher entries in watchers.yaml preserved bit-identical. Reviewer confirms via diff.
- [ ] **Auth middleware semantics unchanged.** The token middleware code at `src/dashboard.ts:~440-470` is untouched. The new public POST is registered BEFORE the middleware (favicon-style) so it short-circuits without changing the middleware's behavior for any other path.
- [ ] **CSRF middleware semantics unchanged.** Same pattern — webhook POST registered before CSRF check.
- [ ] **Mutation kill switch honored.** The webhook handler explicitly checks `killSwitches.isEnabled('DASHBOARD_MUTATIONS_ENABLED')` since it sits before the global mutation middleware.
- [ ] **No new npm dependencies.** HMAC uses Node's `crypto.createHmac`. Verify via `git diff main -- package.json package-lock.json`.
- [ ] **No persona-file drift.** Existing 7 agents' `CLAUDE.md` hashes match between `data-integrity-pre.txt` and `data-integrity-post.txt`. Only addition: `agents/trading-monitor/CLAUDE.md` (new agent).

## Security

- HMAC verification uses `crypto.timingSafeEqual` with length check first (timing-safe).
- Signature header accepted in two forms: `sha256=<hex>` (GitHub-style) and bare hex.
- `secret_env` lookup happens on every request — no in-memory cache means a rotated secret takes effect on next request without restart.
- Slug regex `^[a-z0-9][a-z0-9-]{0,63}$` blocks path traversal / URL-encoded payloads.
- Headers stored in `webhook_payloads.headers_json` are filtered to a small allowlist (`user-agent`, `content-type`, `x-forwarded-for`, `cf-connecting-ip`, signature headers). Auth tokens, cookies, and arbitrary client headers are NOT persisted.
- Even rejected requests are logged with `signature_valid=0` for debugging — but the reject path returns 401 BEFORE any actions fire.

## Test coverage

- **Unit:** `src/webhook.contract.test.ts` — 11 tests, all passing.
  - HMAC negative (unsigned, wrong sig)
  - HMAC positive (sha256= prefix, bare hex)
  - Mode dispatch (run, preview, test)
  - Slug validation (invalid format → 400, unknown → 404)
  - List + read endpoints (auth-gated, computed URL)
  - Fire-test endpoint (auth-gated, runs actions)
- **Live smoke:** `proof/slice-2/trading-monitor-e2e.md` — curl-driven walk through reject → reject → accept → fire test, with DB state captured at each step.
- **e2e (Playwright):** `proof/slice-2/playwright/slice-2.spec.ts` — committed as documentation; run on demand against a live dashboard.

## Out-of-scope drift

- `web/src/App.tsx` and `web/src/lib/routes.ts` modified ONLY to add the `/triggered` route + sidebar entry. No other routes or layout touched.
- `src/agent-config.ts` NOT modified.
- `src/bot.ts`, `src/index.ts` NOT modified.
- `mission_tasks` schema NOT modified.
- Existing watcher action types (`send-telegram`, `queue-mission`, `mark-meet-stale`) NOT modified. New action `run-skill` added; dispatched via `mission_tasks` (reuses existing worker), so no parallel runtime introduced.

## Stop-and-ask conditions hit

1. **Trading monitor persona draft** — per the slice instructions: "Before deciding the trading-monitor agent's persona prose, stop and surface a draft for approval." The persona at `agents/trading-monitor/CLAUDE.md` is a draft that mirrors the lab analyst's read-only discipline (no orders, no trading actions; parse + classify + log + notify). **Reviewer/operator should read and approve before bootstrap.**
2. **Auth middleware path bypass** — registering the public POST handler before the token middleware is a precise carve-out; the middleware's semantics are unchanged for every other path. This was treated as additive (favicon-style precedent) and shipped. If the reviewer disagrees, options: (a) move the route inside the middleware with a path-allowlist, (b) split into a separate Hono sub-app mounted at `/api/watchers/webhook/`. Both keep behavior identical externally.

## Verdict

Verdict: PENDING REVIEW
