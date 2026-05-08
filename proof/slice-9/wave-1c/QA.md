# Slice 9 Wave 1C — QA report

**QA performed by:** implementation agent (Claude Opus 4.7)
**QA date:** 2026-05-08
**Worktree:** `.claude/worktrees/agent-a39d705ee49669353`
**Branch:** `slice-9-wave-1c`
**Base commit:** `e38bf63` (Wave 0)

## What shipped

Two atomic commits on `slice-9-wave-1c`:

1. `feat(cron): estimateCronIntervalSec + classifyTaskHealth helpers`
   Adds two pure functions to `web/src/lib/cron.ts`:
   - `estimateCronIntervalSec(cron)` — derives seconds-between-fires
     for the cron shapes ClaudeClaw users actually write
     (every-N-min, every-N-hour, daily HH:MM, weekly DOW HH:MM,
     custom-DOW). Returns `null` for irregular shapes so callers
     skip the freshness check rather than guess.
   - `classifyTaskHealth({ cron, lastRun, lastStatus, status })` →
     `{ tone, label, intervalSec }`. Tones map to the existing
     `Pill` / `StatusDot` palette (`done` / `medium` / `failed` /
     `neutral`).

2. `feat(scheduled): per-task health row + recent-runs panel`
   Wires the helpers into `web/src/pages/Scheduled.tsx`:
   - `<HealthSummary>` — single-line `[dot] last run Xh ago · <label>`
     row, rendered in both card view and list view (under the prompt /
     in the Status cell respectively).
   - `<RecentRunsPanel>` — collapsible per-card panel that surfaces
     the last `last_run` line plus a deferred-history note that calls
     out the architectural gap honestly: scheduler.ts runs tasks
     inline, no `scheduled_runs` history table exists today, and
     `/api/activity?source=scheduled` returns 0 rows.
   - `See all in Activity` future-proofed link to
     `/mission?activity_source=scheduled&activity_source_id=<id>`.

## Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Each scheduled-task row shows: schedule preview, last-run timestamp, last-run status, status dot | PASS — see screenshots/scheduled-with-stats.png |
| 2 | Status dot logic correct (green / yellow / red rules) | PASS — verified for live row (`success`, fired 5h ago, daily cron → green/healthy). Unit-level paths covered in `classifyTaskHealth`: failed → red, timeout → yellow, late by 1× → yellow, late by 2× → red, paused → neutral, no run → neutral |
| 3 | `See all in Activity` link uses URL params matching Wave 1A | PASS — `/mission?activity_source=scheduled&activity_source_id=ef425086` (verified in live DOM and Playwright spec) |
| 4 | Deferred-history note rendered honestly when no history captured | PASS — copy mentions `src/scheduler.ts`, `mission_tasks`, "deferred slice" |
| 5 | Existing CRUD (Create / Edit / Delete) untouched | PASS — `New Scheduled Task` button, Pause / Delete row icons, Edit modal wiring all unchanged. `/api/tasks` GET/POST/PATCH/DELETE/pause/resume not edited |
| 6 | Console clean | PASS — Playwright captured 0 errors, 0 warnings during page load and view-switch (only Vite HMR debug noise) |
| 7 | QA gate: Playwright e2e + Chrome DevTools MCP smoke | PASS — `proof/slice-9/wave-1c/playwright/wave-1c.spec.ts` written; live smoke captured via Playwright MCP against `localhost:5179` (Vite dev server proxying `/api` → `:3141` running dashboard) |

## Live smoke evidence

- **Card view:** screenshots/scheduled-with-stats.png — full page,
  shows the scheduled task row with `[dot] last run 5h ago · healthy`
  health summary plus the Recent runs panel below.
- **List view:** screenshots/scheduled-list-view.png — same data in
  list mode; health summary appears inline in the Status cell.
- **Deferred-history zoom:** screenshots/deferred-history-note.png —
  isolated capture of the Recent runs panel showing the honest note
  and the future-proofed Activity link.

## Data-integrity invariants (pre vs post)

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `scheduled_tasks` row count | 1 | 1 | MATCH |
| `mission_tasks` row count | 87 | 87 | MATCH |
| `scheduled_tasks` schema | unchanged | unchanged | MATCH |
| `/api/tasks` response shape | 13 keys | 13 keys | MATCH |

Full pre/post baselines at `data-integrity-pre.txt` and
`data-integrity-post.txt`.

## Out-of-scope items honoured

- Did NOT wire `src/scheduler.ts` to write `mission_tasks` rows on
  fire (separate deferred slice — surfaced honestly in the Recent
  runs note).
- Did NOT add a `scheduled_runs` history table.
- Did NOT change `/api/activity`.
- Did NOT touch `web/src/pages/Triggered.tsx` or
  `web/src/pages/MissionControl.tsx`.
- Did NOT add npm dependencies. The cron→english + cron→interval
  helpers are pure JS regex/expansion sitting alongside the existing
  `describeCron` in `web/src/lib/cron.ts`.

## Type-check status

`npx tsc --noEmit -p web/tsconfig.json` reports the same 3
pre-existing errors in `Scheduled.tsx` (lines 186, 226, 257 —
`selected: boolean | undefined` complaints in pre-Wave-1C list /
modal call sites). Verified by checking out the wave-0 commit and
re-running tsc — same 3 errors, identical line numbers. Wave 1C
introduces zero new type errors.

`npx vite build` succeeds.

## Verdict

**PASS.**

All 7 acceptance criteria met. CRUD untouched. Data integrity preserved.
Deferred work clearly disclosed in the UI rather than papered over.

## Files of record

- `proof/slice-9/wave-1c/REVIEW.md` — reviewer template (pending)
- `proof/slice-9/wave-1c/QA.md` — this file
- `proof/slice-9/wave-1c/data-integrity-pre.txt` / `data-integrity-post.txt`
- `proof/slice-9/wave-1c/playwright/wave-1c.spec.ts`
- `proof/slice-9/wave-1c/screenshots/scheduled-with-stats.png`
- `proof/slice-9/wave-1c/screenshots/deferred-history-note.png`
- `proof/slice-9/wave-1c/screenshots/scheduled-list-view.png`
- `web/src/lib/cron.ts` — added helpers
- `web/src/pages/Scheduled.tsx` — page changes
