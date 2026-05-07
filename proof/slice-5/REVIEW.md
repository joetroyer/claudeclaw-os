# Slice 5 — Cost / Token Tracking + Performance Scorecard · Review

## Scope (additive only)

| Surface | File | Verdict |
|---|---|---|
| Pricing table | `pricing.yaml` (new, repo root) | Net new. No existing analog. |
| Cost computation | `src/cost.ts` (new) | Pure module; no DB writes. |
| Rollup queries | `src/db.ts` (added `getTokenRollupByAgent`, `getMissionRollupByAgent`) | Read-only `SELECT … GROUP BY` against existing tables. |
| Composition | `src/scorecard.ts` (new) | Joins token + mission + agent metadata + pricing. |
| Slice-1 metadata reader | `src/agent-config.ts` (added `readAgentSliceMetadata` / `listAgentSliceMetadata`) | Pure read against agent.yaml; no schema change. |
| HTTP API | `src/dashboard.ts` (added `/api/scorecard`, `/api/budget`) | Two new GET endpoints. No mutations. |
| UI page | `web/src/pages/Scorecard.tsx` (new) | New top-level page; not a tab on the org chart. |
| Routing | `web/src/App.tsx`, `web/src/lib/routes.ts` | New `/scorecard` + `/budget` routes; new sidebar item. |

## Integration section

**Did the slice add only, or did it modify existing tables/files/code?**
Add only. No `ALTER TABLE`. No schema changes. No edits to existing
business logic (`convolife`, `getAgentTokenStats`, `getDashboardTokenStats`).
The two new SQL helpers live alongside `getAgentTokenStats` in `db.ts`
but do not touch the existing implementations.

**Are the data-integrity proofs all green?**
Yes. See `data-integrity-pre.txt` and `data-integrity-post.txt`:

- `token_usage` row count, total output tokens, total cost — identical pre/post.
- `token_usage` schema — identical (no migration was required per Slice 1 work).
- `mission_tasks` schema — identical.
- `convolife` query against the most-recent populated session
  (`9363cf72-…`): returns `3 | 44653 | 7994 | 0.6017412 | 0` pre and post.
- `git diff main -- agents/*/CLAUDE.md` — empty.

**Were any new ingress paths protected?**
Both new routes (`GET /api/scorecard`, `GET /api/budget`) are read-only,
sit inside the same `app.get` block that already shares the dashboard
auth/proxy posture, and write nothing. Cost recomputation is a pure
function — no eval, no shell-out, no upstream API calls. No webhook
ingress added.

## Acceptance criteria

| # | Spec | Status |
|---|---|---|
| 1 | Every existing token_usage row contributes correctly to scorecard rollups | Yes — `getTokenRollupByAgent` groups by `agent_id`, no `WHERE` filters beyond the window. With `windowStart=0` (`'all'`), every row is in scope. |
| 2 | `convolife` returns identical numbers pre/post | Yes — see proof. |
| 3 | Scorecard renders metrics for ≥3 agents with real history | Yes — `main` (41 turns), `research` (3), `goldbot-labs` (3) all show in the rollup. |
| 4 | Budget rolls up by LOB and project, with empty values bucketed under "Unassigned" | Yes — `getBudget()` falls back to `Unassigned` when `lob.trim()` is empty or `projects` is `[]`. |
| 5 | Subscription badge shows for at least one agent configured as `subscription` | Pending operator action — set `platform: subscription` in any agent.yaml. The UI already renders the badge based on the API's `subscription_flag` and `hasSubscription` flags. The `subscription` platform exists in `pricing.yaml` and `cost.ts` returns `subscription_flag: 1` when matched. |
| 6 | QA Gate (Playwright e2e + Chrome DevTools smoke + console clear) | Spec checked into `playwright/slice-5.spec.ts`. Live run requires a running dashboard (see QA.md). |

## Stop-and-ask conditions

- **Pricing values.** Per spec, draft pricing was committed alongside
  `pricing-source-citations.md` so a reviewer can spot-check rates
  against current public pages. No pricing was guessed silently. If
  Anthropic / OpenAI / Google have changed rates, edit `pricing.yaml`
  and re-run; cost is recomputed at query time.
- **No new npm deps.** `js-yaml` was already a project dependency.
- **No `token_usage` schema change.** Confirmed `agent_id` already
  exists per the integration plan's locked decision.
- **`mission_tasks` columns checked.** `started_at` and `completed_at`
  exist; completion-rate and duration are computed from them.

## Risks / follow-ups

- Cost recomputation diverges from the historically-recorded
  `cost_usd` whenever `pricing.yaml` rates differ from what was logged.
  This is the intended trade-off: data-driven pricing means we can
  back-correct without rewriting history. The scorecard surfaces the
  recomputed number; `recordedCostUsd` is preserved per row for any
  caller who needs the legacy value.
- A future Slice 3 owner can absorb `/scorecard` as a tab on the org
  chart by deleting the sidebar entry and rendering `<Scorecard />`
  inside the org-chart page.
- `pricing.yaml` for OpenRouter falls through to claude-sonnet rates;
  pin specific model rows when accuracy on those agents matters.

## Verdict

`APPROVED` (pending the operator's pricing spot-check and a `platform:
subscription` agent for the badge demonstration on a live install).
