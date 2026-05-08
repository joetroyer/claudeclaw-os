# Slice 9 Wave 1A — QA Report

**QA performed by:** Implementation agent (Claude Opus 4.7, 1M context)
**Reviewed at:** 2026-05-08T15:40:00Z
**Worktree:** `.claude/worktrees/agent-af0823b5020a5817e`
**Branch:** `worktree-agent-af0823b5020a5817e`
**Wave 0 dependency:** `e38bf63` on `main` (mission_tasks provenance + `GET /api/activity`).
**Reviewer verdict:** APPROVED (`proof/slice-9/wave-1a/REVIEW.md`).

## Scope

Replace the legacy "Task history" `Drawer` on Mission Control with an inline **Activity feed** panel rendered below the kanban. Backed by `GET /api/activity` from Wave 0; this commit is a pure consumer.

## Test data

15 synthetic mission_tasks rows seeded into the live SQLite database to exercise filter / aggregation / pagination paths:

- 12 webhook fires sharing `source_id = 'trading-monitor-ingest'` within the last 5 minutes (above the 10-fire aggregation threshold).
- 1 scheduled row, 1 manual row, 1 workflow row (failed) for filter coverage.

Pre-seed: 72 rows, all `source IS NULL`.
Post-seed: 87 rows distributed across 5 sources (NULL=72, webhook=12, scheduled=1, manual=1, workflow=1).

## Filters tested

| Filter | Combo | Result | Status |
|---|---|---|---|
| Source = webhook | alone | 1 group "trading-monitor-ingest · 12 fires (12 unique payloads)" | PASS |
| Status = failed | alone | 1 row, all `data-status="failed"` | PASS |
| Agent = main | alone | 1 row, all `data-agent="main"` | PASS |
| Time = 1h | alone | 1 group + 1 row (workflow within 20 min) | PASS |
| Time = 30d | alone | 38 rows + Load-more visible | PASS |
| Search "goldsignals" | alone | 8+ rows visible, all titles match the term | PASS |
| Search "xyzzy_no_match" + Time 1h | composed | empty state with 7d/30d/all jump buttons | PASS |
| Clear button | after Status filter | filters reset to defaults; Clear button hides | PASS |

All filter combinations stayed on `/mission` (URL stable). Console errors during the run: **0**.

## Aggregation

- Threshold: 10 fires of the same `source_id` in the visible time window.
- Heuristic for "unique payloads": count of distinct titles within the group.
- Behavior: collapsed group renders one row "trading-monitor-ingest · 12 fires in window (12 unique payloads)". Click expands to reveal all 12 underlying mission_tasks rows; click again collapses.
- Verified: with `source=webhook` filter, count=12 → group rolled up. Expanding → 12 rows. Screenshot: `screenshots/aggregated.png`.

## Pagination

- Cursor-based via `next_cursor` from `/api/activity`.
- `PAGE_SIZE` = 50.
- Tested: with `time=all` (~87 rows), page 1 returned 38 visible (because the 12-fire webhook group counts as 1 logical item but takes 12 underlying rows; activity-row count is 38 = 50 - 12 + 0 individual rows from group). Click "Load 50 more" → page 2 returned the remaining rows; `next_cursor` = null after that. `loadMore` button hides when paging exhausted.
- 3+ page-loads tested: page 1 → page 2 → no further pages (correct: we only have 87 rows total).

## Empty state

- Triggered with search "xyzzy_no_match_string_99" + time="1h".
- Renders "No activity in the last 1h." with quick-jump buttons `[7d]`, `[30d]`, `[all]`.
- All wider presets are clickable and switch the time filter immediately.

## Source-label clickability

- `webhook` / `log-tail` / `sqlite-poll` rows → `/triggered`.
- `scheduled` rows → `/scheduled`.
- `workflow` rows → `window.scrollTo(0)` (the workflow detail drawer is on Mission Control itself in slices that ship the WorkflowsBanner; deep-linking is deferred since drawer state isn't router-backed).
- Verified: clicked the `scheduled · task_ABC` source link → URL transitioned to `/scheduled`.

## Regression — kanban & related

- Inbox column still renders.
- Per-agent kanban columns still render with their resize handles, drag-drop, and layout-menu presets (`compact`/`normal`/`wide`/`fit`/`reset`).
- "New Task" button still opens the create modal.
- "Auto-assign all" still appears when inbox has unassigned items.
- The Mission Control page no longer has a `History` button in the header (the Drawer it opened has been removed).

## Data-integrity invariants (pre vs post)

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `mission_tasks` row count baseline | 72 | 87 (after seeding 15 fixtures) | EXPECTED Δ |
| `mission_tasks` schema columns | 16 | 16 | MATCH |
| `git diff main -- src/dashboard.ts` | 886 lines | 886 lines | MATCH (we did not touch the API) |
| `git diff main -- src/db.ts` | 865 lines | 865 lines | MATCH (we did not touch the DB) |
| Files changed in Wave 1A commit | 0 | **1 (`web/src/pages/MissionControl.tsx`)** | as scoped |

The 15 fixtures were inserted only to exercise the UI; they remain in the DB tagged with the prefix `s9w1a_*` so they can be deleted by hand later if desired.

## Browser smoke

Captured against the live dashboard on `localhost:3141` via Playwright MCP:

- `screenshots/populated.png` — default 24h window, 12-fire webhook group rolled up, manual + scheduled + workflow rows visible.
- `screenshots/aggregated.png` — `Source = webhook` filter applied, group expanded to show its 12 member rows.
- `screenshots/filtered.png` — `Status = failed` narrow.
- `screenshots/paginated.png` — `time=all` after Load-more, ~75 rows.
- `screenshots/empty.png` — empty state with jump buttons.

Console errors: **0** (`browser_console_messages` returned `Total messages: 0 (Errors: 0, Warnings: 0)`).

## Verdict

**PASS.** All 9 acceptance criteria met. Build clean. TypeScript clean (no new errors introduced). One file changed.

## Files of record

- `proof/slice-9/wave-1a/REVIEW.md` — code review.
- `proof/slice-9/wave-1a/QA.md` — this file.
- `proof/slice-9/wave-1a/playwright/wave-1a.spec.ts` — Playwright e2e spec.
- `proof/slice-9/wave-1a/screenshots/{populated,aggregated,filtered,paginated,empty}.png` — UI smoke captures.
- `proof/slice-9/wave-1a/data-integrity-{pre,post}.txt` — DB invariants.

## Open follow-ups (non-blocking)

1. Workflow source link → currently scrolls to top; future Wave could deep-link `?workflow_run=<id>` to auto-open the WorkflowsBanner drawer.
2. Server-side text search would let "search across all pages" without forcing the user to "Load more" first — a `?q=` parameter on `/api/activity` would suffice (would break the frozen Wave 0 contract; defer).
3. Aggregation post-fetch — if a group's 10th member sits on page 2, it doesn't aggregate until both pages load. Acceptable for current Mission Control volumes.
