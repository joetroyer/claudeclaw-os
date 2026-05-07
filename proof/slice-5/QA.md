# Slice 5 — QA Plan

## Static gates

| Gate | Command | Result |
|---|---|---|
| Type-check | `npm run typecheck` | PASS — no errors. |
| Web build | `npm run build:web` | PASS — bundles produced. |
| Cost unit tests | `npx vitest run src/cost.test.ts` | PASS — 9/9 tests (computeCost, isSubscription, listPlatforms, fallbacks). |
| Cost-footer unit tests | `npx vitest run src/cost-footer.test.ts` | PASS — 10/10 (existing, unchanged). |
| Avatar unit tests | `npx vitest run src/avatars.test.ts` | PASS — 14/14 (sanity check: nothing else broke). |

Note: the wider vitest run trips on the pre-existing better-sqlite3
ABI mismatch with Node 25 in this worktree. Tests that don't open a
DB pass cleanly. No new test introduced by this slice opens a DB.

## Data integrity proof

`data-integrity-pre.txt` and `data-integrity-post.txt` are committed
alongside this file.

- `token_usage` row count: **47** pre and post.
- `token_usage` total output tokens: **69136** pre and post.
- `token_usage` total cost: **$9.5222847** pre and post.
- `token_usage` schema: bit-identical (verified via `.schema`).
- `mission_tasks` schema: bit-identical.
- `convolife` query against session `9363cf72-…`:
  `3 | 44653 | 7994 | 0.6017412 | 0` pre and post.
- `git diff main -- agents/*/CLAUDE.md`: empty.

## Live QA gate (Playwright + Chrome DevTools)

Run after the dashboard is started locally (`npm run dev` boot of the
main bot, or the launchd job if testing in production).

```
npx playwright test proof/slice-5/playwright/slice-5.spec.ts
```

The spec covers:
1. Navigate to `/scorecard`. Confirm tab "By agent" is selected by
   default and the table renders with at least one populated row from
   the live DB.
2. Switch the window picker to `7d`, `90d`, `all`. Each switch should
   refetch and re-render without console errors.
3. Switch tab to "By LOB / project". Confirm both LOB and project
   sections render, with at least an "Unassigned" bucket containing
   `main`.
4. Click an LOB chip; the project list should filter. Click again to
   un-filter.
5. Confirm `subscription` badge renders when any agent's `platform` is
   `subscription` in agent.yaml. (Verified by setting `meta` agent's
   platform to `subscription` for this test, then resetting after.)
6. Console errors throughout the run = 0.

Screenshots committed in `screenshots/`:
- `scorecard.png` — agent table view.
- `budget.png` — LOB + project view.

## Console clear check (Chrome DevTools MCP)

When the dashboard is live, manual run:

1. `mcp__plugin_chrome-devtools-mcp__navigate_page` to `/scorecard`.
2. `mcp__plugin_chrome-devtools-mcp__list_console_messages` →
   expect zero `error`-level entries.
3. Repeat for `/budget`.
4. `mcp__plugin_chrome-devtools-mcp__take_screenshot` for each view.

## Subscription badge scenario

To validate badge rendering on a live install:

```bash
# Pick any agent that's allowed to be flat-fee (e.g. meta).
# Edit agents/meta/agent.yaml → platform: subscription
# Hit /api/scorecard?window=all and confirm:
#   - that agent's row has subscription_flag = 1
#   - costUsd = 0
#   - the UI renders the "subscription" pill in the Cost cell
```

The pricing.yaml entry for `subscription` already has
`subscription: true`. cost.ts honours it without code changes.
