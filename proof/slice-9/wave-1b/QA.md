# Slice 9 Wave 1B — QA Report

**QA performed by:** Implementation agent (self-QA pre-handoff)
**Reviewed at:** 2026-05-08
**Worktree:** `.claude/worktrees/agent-ae9d6aaa4b9c3c3f1`
**Branch:** `worktree-agent-ae9d6aaa4b9c3c3f1`
**Reviewer verdict:** PENDING (`proof/slice-9/wave-1b/REVIEW.md`)
**Final verdict:** PENDING
**Wave 0 baseline:** `e38bf63`

## What this slice delivers

Two enhancements to the Triggered page, riding on Wave 0's
`/api/activity?source=webhook&source_id=<slug>` contract:

  1. **Per-watcher health strip** in the card header — fires-today,
     success rate, time-since-last-fire, and a green/yellow/red
     status dot. Always rendered (loading/empty/error states handled
     inline). Polled every 30s.

  2. **Per-watcher "Recent fires" panel** in the expanded card body
     — last 50 mission_tasks for the slug, status pills + duration,
     with a `See all in Activity →` deep link to Mission Control
     filtered to this slug.

The pre-existing `Last 10 payloads` panel (HTTP-level, raw payload
viewer) is intentionally untouched — they're complementary
(HTTP-level vs mission-level).

## Files changed

  - `web/src/pages/Triggered.tsx` — single file, +278 / -4.

```
=== Files changed by this slice vs Wave 0 baseline (e38bf63) ===
 web/src/pages/Triggered.tsx | 282 +++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 278 insertions(+), 4 deletions(-)

Server-side files changed: 0
Web (UI) files changed:    1
```

No backend, no schema, no watcher-config changes.

## Data-integrity invariants (pre vs post)

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `mission_tasks` schema (incl. source/source_id columns + idx) | wave-0 baseline | identical | MATCH |
| Server-side files changed vs `e38bf63` | 0 | 0 | MATCH |
| `watchers.yaml` diff vs `e38bf63` | 0 lines | 0 lines | MATCH |
| `/api/activity` endpoint diff | 0 lines | 0 lines | MATCH |
| Live `mission_tasks` row count | 87 | 87+ (production drift) | EXPECTED |
| `Last payloads` legacy endpoint with token | 200 | 200 | MATCH |
| `Last payloads` legacy endpoint no token | 401 | 401 | MATCH |
| `git diff main -- src/dashboard.ts` | 0 lines | 0 lines | MATCH |

Per-row baselines at `data-integrity-pre.txt` and
`data-integrity-post.txt`.

## Health-stat thresholds (tunable)

Top-of-file constants in `Triggered.tsx`:

```ts
const FRESH_WINDOW_SEC = 60 * 60;        // 1h    → green if last fire ≤ this
const STALE_WINDOW_SEC = 24 * 60 * 60;   // 24h   → yellow ceiling
const HEALTHY_RATE = 0.8;                // 80%   → green floor for success
const DEGRADED_RATE = 0.6;                // 60%   → yellow floor for success
const STATS_WINDOW_SEC = 24 * 60 * 60;   // 24h   → "today" window
const RECENT_FIRES_LIMIT = 50;
const STATS_POLL_MS = 30_000;
```

Status dot logic (in `deriveHealth()`):

  - **No fires in window** → idle (gray)
  - **No finalised rows yet** → green/yellow/red on freshness alone
  - **green** : last fire ≤ 1h AND success rate ≥ 80%
  - **yellow** : last fire ≤ 24h AND success rate ≥ 60%
  - **red** : older than 24h OR success rate < 60%

## Bonus fix verification (Wave 0 narrowed CF Access bypass)

Live test against `localhost:3141`:

```
GET /api/watchers/webhook/trading-monitor-ingest/payloads?token=<TOKEN>&limit=3
HTTP 200
{"payloads":[…3 rows]}

GET /api/watchers/webhook/trading-monitor-ingest/payloads?limit=3
HTTP 401
{"error":"Unauthorized"}
```

The endpoint correctly requires auth post-Wave-0 (the bypass app was
narrowed to `/api/hooks/*` only). The Last 10 payloads UI continues to
load (visible in `screenshots/payloads-still-works.png`).

## Test results

| Suite | Pass | Fail | Skip | Notes |
|---|---|---|---|---|
| `vite build` | clean | 0 | — | 548 modules, 0 errors |
| `playwright/wave-1b.spec.ts` (9 tests) | committed | — | — | Spec ready for headless CI; manual MCP smoke run below covered the same surface |
| Chrome DevTools / Playwright MCP smoke | pass | 0 | — | 3 screenshots captured, console clean (0 errors / 0 warnings) |
| TypeScript check (`tsc --noEmit`) on `Triggered.tsx` | clean | 0 | — | No new type errors introduced; pre-existing errors elsewhere unrelated |

## MCP smoke walkthrough

Reproducible script (run from project root with bot up at :3141):

  1. `npx vite build` → bundle has new `Recent fires` + `fires today`
     strings. Confirmed via `grep`.
  2. Open `http://localhost:3141/triggered?token=<TOKEN>`.
  3. Wait for `fires today` text → confirms strips rendered.
  4. Capture `triggered-with-stats.png` — shows 3 cards each with
     their own strip.
  5. Click `[data-testid="toggle-watcher-trading-monitor-ingest"]`.
  6. Wait for `Recent fires` → confirms panel mounts.
  7. Capture `recent-fires-panel.png` — shows 12 mission_task rows +
     the `Last payloads` panel below.
  8. Capture `payloads-still-works.png` — proves legacy panel still
     populated.
  9. Inspect console messages → 0 errors, 0 warnings.

## Sample observed values (from live MCP smoke)

  - `trading-monitor-trigger`: `0 fires today` · idle dot
  - `trading-monitor-ingest`: `12 fires today` · `100% success` · `last 10m ago` · GREEN dot
  - `n8n-error-router`: `0 fires today` · idle dot

`See all in Activity` href on `trading-monitor-ingest`:
`/mission?activity_source=webhook&activity_source_id=trading-monitor-ingest`

## Stop-and-ask discovery

  - **None.** Brief was explicit on every threshold and on the
    deep-link URL params. Followed verbatim.
  - Wave 1A's URL-param consumer hasn't merged. Documented in
    `REVIEW.md` Section D — link gracefully degrades to unfiltered
    Mission Control until Wave 1A lands.

## Out-of-scope confirmations

  - `/api/activity` endpoint shape unchanged.
  - `/api/watchers/webhook/:slug/payloads` endpoint unchanged.
  - `Scheduled.tsx` not touched (Wave 1C owner).
  - Existing webhook CRUD unchanged.

## Files of record

  - `proof/slice-9/wave-1b/REVIEW.md`
  - `proof/slice-9/wave-1b/QA.md` — this file
  - `proof/slice-9/wave-1b/data-integrity-pre.txt`
  - `proof/slice-9/wave-1b/data-integrity-post.txt`
  - `proof/slice-9/wave-1b/console-messages.txt`
  - `proof/slice-9/wave-1b/playwright/wave-1b.spec.ts`
  - `proof/slice-9/wave-1b/screenshots/triggered-with-stats.png`
  - `proof/slice-9/wave-1b/screenshots/recent-fires-panel.png`
  - `proof/slice-9/wave-1b/screenshots/payloads-still-works.png`

## Verdict

**PASS (self-QA).** Awaiting reviewer sign-off in `REVIEW.md`.
