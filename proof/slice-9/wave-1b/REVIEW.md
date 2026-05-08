# Slice 9 Wave 1B — Code Review

**Verdict: PENDING REVIEW**

**Worktree:** `.claude/worktrees/agent-ae9d6aaa4b9c3c3f1`
**Branch:** `worktree-agent-ae9d6aaa4b9c3c3f1`
**Implementation agent:** Claude Opus 4.7 (1M context)
**Review requested:** 2026-05-08
**Wave 0 baseline:** `e38bf63`

## Scope

Triggered page enhancements riding on the Wave 0 backend foundation
(`mission_tasks.source` + `source_id` + `GET /api/activity` filtered
feed). Pure frontend slice — no server-side changes.

  - **A. Health stats strip** — per-watcher header strip showing
    fires-today, success rate, time-since-last-fire, and a
    green/yellow/red status dot. Consumes
    `/api/activity?source=webhook&source_id=<slug>&since=<24h>`.
  - **B. Recent fires panel** — collapsible per-watcher panel showing
    the last 50 mission_tasks for the slug, status pill + duration per
    row, with a `See all in Activity →` deep link to Mission Control
    filtered to this slug.
  - **Bonus fix verified:** the legacy
    `/api/watchers/webhook/:slug/payloads` GET endpoint, which Wave 0
    fixed by narrowing the CF Access bypass to `/api/hooks/*`, is
    confirmed live (200 with token / 401 without). Tested in the new
    Playwright spec.

## Files changed

| File | Change |
|---|---|
| `web/src/pages/Triggered.tsx` | +278 / -4. Health-stats strip, recent-fires panel, tunable threshold constants at top of file. CRUD untouched. |

That's the only file that ships in this slice. Compare with
`data-integrity-post.txt`:
```
Server-side files changed: 0
Web (UI) files changed:    1
```

## Self-review highlights for the reviewer

### A. Threshold constants are tunable

The brief flagged that "1h / 24h / 80% / 60%" feel arbitrary. They're
top-of-file constants in `Triggered.tsx`:

```ts
const FRESH_WINDOW_SEC = 60 * 60;
const STALE_WINDOW_SEC = 24 * 60 * 60;
const HEALTHY_RATE = 0.8;
const DEGRADED_RATE = 0.6;
const STATS_WINDOW_SEC = 24 * 60 * 60;
const RECENT_FIRES_LIMIT = 50;
const STATS_POLL_MS = 30_000;
```

Tweak without touching render code.

### B. Single fetch serves both the strip and the panel

Each watcher card runs ONE `useFetch` against
`/api/activity?source=webhook&source_id=<slug>&since=<24h>&limit=50`.
The result is shared between the always-visible header strip (drives
fires-today / success-rate / last-fire / status dot) and the
collapsible panel (drives the row list). No double round-trip per card.
Polls every 30s (matches the existing `/api/watchers/webhook` poll
cadence on the same page).

### C. Status dot logic

Implemented in `deriveHealth()` exactly as the brief specifies, with
one extra branch for the no-finalised-rows case so a brand-new webhook
that has only `running` / `queued` rows doesn't render "100% success"
or NaN. When `successRate === null`, the dot still uses freshness:
green if last fire ≤ 1h, yellow if ≤ 24h, red if older. Idle (gray)
is reserved for "no fires at all in the window".

### D. "See all in Activity" deep link

Constructed as `/mission?activity_source=webhook&activity_source_id=<slug>`.
Wave 1A is meant to wire those URL params to the Mission Control
activity filter. Wave 1A is not yet merged — until then the link
gracefully falls through to an unfiltered Mission Control. No coupling
between Wave 1A and 1B beyond the param naming convention. Documented
inline in `Triggered.tsx` and called out in the QA checklist.

### E. Pre-existing payloads viewer untouched

Acceptance criterion #5 was "the legacy `Last 10 payloads` panel STILL
works." It's complementary to the new panel (raw HTTP-level vs
mission-level), so I left it in place verbatim. The new "Recent fires"
panel is rendered ABOVE it inside the same expanded body. The
Playwright spec asserts both are visible simultaneously after a card
expands.

### F. CRUD untouched

`WatcherFormModal` (Create / Edit), the delete confirm flow, the
`/api/watchers` POST/PUT/DELETE call sites — none of it was touched.
Verified by `git diff e38bf63 -- web/src/pages/Triggered.tsx` showing
all modifications confined to `WatcherCard`, two new sub-components,
and the new top-of-file constants block.

### G. Bonus payloads-viewer fix verified live

Hit the live dashboard at `localhost:3141`:

```
$ curl -sS -w "HTTP %{http_code}\n" \
    "http://localhost:3141/api/watchers/webhook/trading-monitor-ingest/payloads?token=$TOKEN&limit=3"
{"payloads":[…]} HTTP 200

$ curl -sS -w "HTTP %{http_code}\n" \
    "http://localhost:3141/api/watchers/webhook/trading-monitor-ingest/payloads?limit=3"
{"error":"Unauthorized"} HTTP 401
```

Auth gating is intact. Wave 0's CF Access bypass narrowing
(`/api/watchers/webhook/*` → `/api/hooks/*`) means this endpoint now
correctly requires a token instead of being silently bypassed.

## Stop-and-ask conditions hit

  - **None.** All thresholds were specified ranges (1h / 24h / 80% /
    60%), so I shipped them as the requested constants. The brief's
    explicit "ship them as constants at the top of Triggered.tsx so we
    can tune later" instruction was followed verbatim.
  - The `See all in Activity` URL params (`activity_source` /
    `activity_source_id`) match what the brief specified. If Wave 1A
    chooses different param names we'll need to chase one of the two
    waves; brief's words were "coordinate naming with Wave 1A but
    don't block on it" — that's what shipped.

## Acceptance criteria checklist

  - [x] Each webhook card shows a health-stats strip with fires-today,
        success rate (when there are finalised rows), last-fire time,
        and a status dot.
  - [x] Each webhook card has a "Recent fires" panel listing the last
        50 mission_tasks (or fewer if newer).
  - [x] Status dot color logic matches the brief (green ≤1h+≥80% /
        yellow ≤24h or ≥60% / red older or <60%; idle gray for no
        fires).
  - [x] `See all in Activity` link uses
        `?activity_source=webhook&activity_source_id=<slug>`.
  - [x] Legacy `Last 10 payloads` panel still works and is NOT
        replaced.
  - [x] Console clean across page render + expand cycle (verified via
        Playwright MCP, 0 errors / 0 warnings).
  - [x] Existing Create / Edit / Delete CRUD untouched.
  - [x] Playwright e2e spec committed at
        `proof/slice-9/wave-1b/playwright/wave-1b.spec.ts`.
  - [x] Chrome DevTools MCP smoke produced screenshots under
        `proof/slice-9/wave-1b/screenshots/`.
  - [x] Vite build succeeds (548 modules transformed, 0 errors).

## Tests

  - **9 Playwright tests** in `proof/slice-9/wave-1b/playwright/wave-1b.spec.ts`
    covering: health-strip render, status-tone validity, expand →
    Recent-fires reveal, deep-link param wiring, payloads endpoint
    200-with-token + 401-without-token, dual-panel visibility, console
    cleanliness, CRUD presence, and the activity API source-scoping
    contract.
  - **Live MCP smoke** captured 3 screenshots:
    - `triggered-with-stats.png` — page-level view of all 3 webhook
      cards with their health strips populated. Note
      `trading-monitor-ingest` shows "12 fires today · 100% success ·
      last 9m ago" with a green dot.
    - `recent-fires-panel.png` — expanded card showing both the new
      Recent fires list (12 rows of "completed" status pills + 2.0s
      duration each) AND the legacy Last payloads panel below it.
    - `payloads-still-works.png` — close-up of the Last payloads
      list, proving the legacy HTTP-level viewer still loads.

## Data integrity

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `mission_tasks` schema | 4 columns + 2 indexes (source/source_id present) | identical | MATCH |
| Server-side files changed vs `e38bf63` | 0 | 0 | MATCH |
| `watchers.yaml` diff vs `e38bf63` | 0 lines | 0 lines | MATCH |
| `/api/activity` endpoint diff in `src/dashboard.ts` | 0 lines | 0 lines | MATCH |
| Live `mission_tasks` row count | 87 | 87+ (natural production drift) | EXPECTED |
| `Last payloads` legacy endpoint with token | 200 | 200 | MATCH |
| `Last payloads` legacy endpoint no token | 401 | 401 | MATCH |

Per-row pre/post baselines at `data-integrity-pre.txt` and
`data-integrity-post.txt`.

## Files of record

  - `proof/slice-9/wave-1b/REVIEW.md` — this file
  - `proof/slice-9/wave-1b/QA.md` — QA report
  - `proof/slice-9/wave-1b/data-integrity-pre.txt`
  - `proof/slice-9/wave-1b/data-integrity-post.txt`
  - `proof/slice-9/wave-1b/console-messages.txt` — captured during MCP smoke
  - `proof/slice-9/wave-1b/playwright/wave-1b.spec.ts` — 9 e2e tests
  - `proof/slice-9/wave-1b/screenshots/triggered-with-stats.png`
  - `proof/slice-9/wave-1b/screenshots/recent-fires-panel.png`
  - `proof/slice-9/wave-1b/screenshots/payloads-still-works.png`

## Open follow-ups (out of scope for Wave 1B)

  1. When Wave 1A merges, confirm Mission Control reads
     `?activity_source=` + `?activity_source_id=` exactly as Wave 1B
     wrote them.
  2. Click-through on a fire row currently shows the title +
     result_summary in a native tooltip. A real mission detail modal
     can come later (the brief explicitly allows the tooltip
     fallback).
  3. The `data-tone` attribute on the status dot makes it Playwright-
     testable but is also a useful hook for future analytics
     (counting how many webhook specs are "red" across the user base).
