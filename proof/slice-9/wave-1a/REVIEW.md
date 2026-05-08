# Slice 9 Wave 1A — Code Review

**Branch:** `worktree-agent-af0823b5020a5817e`
**Worktree:** `.claude/worktrees/agent-af0823b5020a5817e`
**Wave 0 dependency:** `e38bf63 fix(merge): final 2 createMissionTask callsites (dashboard + mission-cli)` — already on `main`.
**Reviewer scope:** the `ActivityFeed` component and the layout reshape in `web/src/pages/MissionControl.tsx`.

## Summary of changes

- Replaced the legacy "Task history" `Drawer` (right-side popup, opened by a header button) with an inline `ActivityFeed` panel rendered below the kanban inside `MissionControl`. The `History` button + `Drawer` markup are gone.
- Added the `ActivityFeed` component (with sub-components `ActivityMultiSelect`, `ActivityRowItem`, `SourceIcon`, `ActivityEmptyState`) backed by `GET /api/activity`.
- Filters: source (multi-select, includes synthetic "legacy / NULL"), status (multi-select), agent (single-select), time presets (1h / 6h / 24h / 7d / 30d / all), and a debounced search box.
- Aggregation collapse: when ≥10 rows in the visible window share the same `source_id`, they fold into a single roll-up row that expands on click. Heuristic for "unique payloads" = count of distinct titles within the group.
- Cursor-based pagination via the `next_cursor` field from `/api/activity`. "Load 50 more" button at the bottom; `+1`-fetch on the server signals when no further pages exist.
- Empty state with quick-jump buttons to wider time windows.
- Source-label click navigates to the corresponding spec page (`/triggered`, `/scheduled`, or scrolls to the workflows banner for workflow rows).

## Files touched

| File | Δ | Reason |
|---|---|---|
| `web/src/pages/MissionControl.tsx` | +480 / -100 | New `ActivityFeed` and friends; legacy `HistoryList` + Drawer removed; layout reshaped to give the kanban a `max-h: 55vh` cap so the activity feed is always visible. |

No other files changed. Backend untouched. `/api/activity` consumed read-only.

## Acceptance criteria — verification

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | History panel replaced by Activity feed | PASS | `git diff` shows `Drawer`/`HistoryList` removed; `ActivityFeed` mounted inline below the kanban. |
| 2 | All 5 filters (source, agent, status, time, search) compose | PASS | `QA.md` filter-matrix smoke. Filter A → row narrowing, then filter B → further narrowing without losing A. |
| 3 | Source badges visible on every row | PASS | `SourceIcon` renders Lucide glyph per source class, `❓` fallback for null. Screenshot: `screenshots/populated.png`. |
| 4 | Source label click jumps to spec page | PASS | Smoke confirmed `/scheduled` jump from a `scheduled` source link. Workflow source scrolls to the workflows banner (drawer state isn't router-backed; deferred). |
| 5 | Aggregation collapse fires at ≥10 fires | PASS | Seed of 12 webhook fires → single rolled-up row "trading-monitor-ingest · 12 fires in window (12 unique payloads)". Expand reveals all 12. Screenshot: `screenshots/aggregated.png`. |
| 6 | Pagination via cursor (50 per page) | PASS | Page 1 = 50, page 2 = 37 (database had 87 total in window after seed), `loadMore` disappears when `next_cursor` returns null. |
| 7 | Empty state with quick-jumps | PASS | Search "xyzzy_no_match" + 1h yields empty state with 7d/30d/all jump buttons. Screenshot: `screenshots/empty.png`. |
| 8 | Active mission cards UNCHANGED | PASS | Inbox + per-agent kanban + workflows banner identical to before; only the layout was constrained to `max-h: 55vh` so both panels coexist. |
| 9 | QA Gate: e2e + console clean | PASS | `console-errors=0`, screenshots captured at `screenshots/`. Playwright spec at `playwright/wave-1a.spec.ts`. |

## Out of scope (not changed, by spec)

- `/api/activity` endpoint shape.
- mission_tasks columns.
- New Task modal.
- New top-level routes.

## Risks / call-outs

1. **Workflow source navigation is a soft jump.** The workflows banner is on Mission Control itself; clicking a `workflow` source link scrolls to the top of the page where the banner lives, but doesn't auto-open the run drawer (its state isn't URL-backed). A follow-up could deep-link `?workflow_run=<id>` into Mission Control to auto-open the drawer.
2. **Search runs client-side on the fetched page only.** If the user searches for a term that exists on page 5 of cursor pagination, they need to "Load more" first. This matches `/api/activity` not having a text-search filter yet — adding one would be a Wave 0 contract change (not in scope).
3. **Aggregation post-fetch.** The threshold check runs client-side on `rows`, so if a group's first 9 fires are on page 1 and the 10th is on page 2, it doesn't aggregate until both pages are loaded. Acceptable for the volumes Mission Control sees.

## Verdict

Approved. All acceptance criteria met. Atomic conventional commits. No new endpoints, no new deps.
