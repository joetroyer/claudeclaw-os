# Slice 3 — QA Report

**QA performed by:** Implementation agent (worktree-agent-a8df5c79d9d35ae09)
**Captured at:** 2026-05-07T23:00:00Z (pending re-execution post review)
**Worktree:** `.claude/worktrees/agent-a8df5c79d9d35ae09`
**Branch:** `worktree-agent-a8df5c79d9d35ae09`

## Status

`Verdict: PENDING REVIEW`

## Acceptance criteria mapped to evidence

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Org chart loads + renders LOB → project → resource hierarchy from config files | implemented | `web/src/pages/OrgChart.tsx` `HierarchyView`; `lobs.yaml` + `humans.yaml` seed data |
| 2 | LOB → project → resource click-through works | implemented | `proof/slice-3/playwright/slice-3.spec.ts` `walks the hierarchy` test |
| 3 | Drawer shows Four Rs (`four_rs.results`) and ownership (`owns.*`) | implemented | `AgentDrawer` in `OrgChart.tsx`; spec test `opens an agent drawer` |
| 4 | Analytics tab shows workload counts and flags overload | implemented | `AnalyticsView` + `/api/org-chart/workload`; `decorateWorkload()` in `src/org-chart.ts` |
| 5 | Ideal vs Active filter works | implemented | `IdealVsActiveView` + filter buttons; spec test `ideal vs active filter` |
| 6 | QA Gate — Playwright e2e + Chrome DevTools MCP smoke + screenshots | spec committed; runtime run pending | `proof/slice-3/playwright/slice-3.spec.ts`; screenshots in `proof/slice-3/screenshots/` once captured |

## Build verification

- `npm run typecheck` — exit 0 (`tsc --noEmit`).
- `npm run build` — exit 0 (`vite build && tsc`). Web bundle landed in `dist/web/` with no warnings or errors related to slice-3 code.
- `npx tsc -p web/tsconfig.json --noEmit` — pre-existing errors in `BrainGraph3D.tsx`, `AgentSuggestions.tsx`, `HiveMind.tsx`, `Scheduled.tsx`, `StandupConfig.tsx`, `AgentFiles.tsx` (none of which were touched by slice 3). No errors originate from `OrgChart.tsx`, `org-chart.ts`, or any modified file.

## API surface added (all GET)

- `GET /api/org-chart/lobs` — returns `{ lobs: Lob[] }` parsed from `lobs.yaml`. Returns `{ lobs: [] }` if the file is missing.
- `GET /api/org-chart/humans` — returns `{ humans: Human[] }` parsed from `humans.yaml`.
- `GET /api/org-chart/agents` — returns the merged agent metadata: `id`, `name`, `description`, `lob`, `projects`, `ideal`, `platform`, `four_rs_results`, `skills_primary`, `owns.*`, `avatar`.
- `GET /api/org-chart/workload?days=N&threshold=K` — returns `{ window_days, overload_threshold, workload[] }` with per-agent `mission_tasks`, `scheduled_tasks`, `total`, `overloaded`, `suggested_breakout`. Defaults: `days=30`, `threshold=20`.

All four hit the existing `/api/*` token / Cf-Access middleware. None mutate state.

## Data-integrity proof

See `data-integrity-pre.txt` and `data-integrity-post.txt`. Key invariants:

1. No commits in this slice touch anything under `agents/`.
2. No working-tree changes under `agents/` at any point.
3. Parent-repo `mission_tasks`, `scheduled_tasks`, and `token_usage` row counts are identical pre and post.
4. SHA-256 of every parent-repo `agent.yaml` is identical pre and post.

## Manual smoke (deferred to runtime sandbox)

The worktree has no committed `agent.yaml` files (worktree-base is pre-Slice-1; the parent repo is where Slice 1 fields actually live). Runtime smoke must be performed against the parent dashboard process, which already serves the parent's `agents/` directory. Steps:

1. Restart the dashboard so the new routes register: `kill $(cat store/claudeclaw.pid) && npm run dev` (or whatever the operator's launchd-managed restart workflow is).
2. Hit each new endpoint with a token: `curl -s "http://localhost:3141/api/org-chart/lobs?token=$TOKEN" | jq`. Same for `/humans`, `/agents`, `/workload`.
3. Open `http://localhost:3141/org-chart?token=$TOKEN`. Click through Hierarchy → LOB → project → agent. Open agent drawer. Switch to Analytics. Switch to Ideal vs Active. Verify console is clean.
4. Capture screenshots into `proof/slice-3/screenshots/{hierarchy,analytics,ideal-vs-active}.png`.

## Files of record

- `lobs.yaml` — LOB seed (4 LOBs, 8 projects).
- `humans.yaml` — Joe + Ali seed.
- `src/org-chart.ts` — server-side parsers + workload decorator.
- `src/db.ts` — `getAgentWorkloadCounts(agentId, sinceSec)` helper added.
- `src/dashboard.ts` — four `GET /api/org-chart/...` routes registered.
- `web/src/pages/OrgChart.tsx` — three-tab page.
- `web/src/App.tsx` — `/org-chart` route registered.
- `web/src/lib/routes.ts` — sidebar + command-palette entry added.
- `proof/slice-3/playwright/slice-3.spec.ts` — e2e spec.
- `proof/slice-3/data-integrity-{pre,post}.txt` — integrity proofs.
- `proof/slice-3/REVIEW.md` — independent reviewer verdict (pending).

## Open follow-ups

1. Run the Playwright spec headlessly against a live dashboard once the parent repo's daemon is restarted and screenshots can be captured.
2. Capture Chrome DevTools MCP console smoke as required by the QA gate.
3. Decide whether the seed `lobs.yaml` / `humans.yaml` content is authoritative or needs editing (see Open Question in spec).
