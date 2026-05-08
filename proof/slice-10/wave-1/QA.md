# Slice 10 Wave 1 — OrgChartV2 page · QA

## What shipped

- New page at `/org-chart-v2` (`web/src/pages/OrgChartV2.tsx`)
- Route wired in `web/src/App.tsx`
- Sidebar + command palette entry added in `web/src/lib/routes.ts`
- All interaction state managed client-side; endpoint `/api/org-chart-v2`
  is consumed read-only.

## How to reproduce locally

1. Make sure the dashboard is running on `http://localhost:3141`.
2. Get the dashboard token from `.env` (`DASHBOARD_TOKEN`).
3. Open in a browser:
   `http://localhost:3141/org-chart-v2?token=<DASHBOARD_TOKEN>`
4. To deep-link with focus mode pre-applied:
   `…/org-chart-v2?token=<TOKEN>&focus=meta`
5. To deep-link with a custom expansion set:
   `…/org-chart-v2?token=<TOKEN>&expand=meta,content,research`

## Acceptance criteria walkthrough

| Criterion | Result | Notes |
|---|---|---|
| `/org-chart-v2` renders default tree | PASS | Top-level cards visible immediately |
| Click title → focus mode | PASS | URL gains `?focus=<id>`; "Exit focus" pill appears top-right |
| Background click → exit focus | PASS | Click on empty canvas while focused unzooms |
| Depth presets 1/2/3/All | PASS | Each click rewrites the expanded set; URL `expand=` reflects |
| Search auto-expands path | PASS | Typing "trading" expands ancestors of trading-monitor + adds match ring |
| Filter chips for type | PASS | Selecting Human dims AI cards to ~40% opacity (still visible) |
| URL state in/out | PASS | `?focus=meta` lands focused; toggling expansion writes `expand=` |
| localStorage persists | PASS | Confirmed via `localStorage.getItem('claudeclaw.org-chart-v2.expansion')` |
| Drawer renders Four Rs / personality / skills / owns / LOB | PASS | Empty-state copy shown for fields the YAML hasn't filled in |
| Cadence badge navigation | PASS | `🗓 N scheduled` → `/scheduled?agent=<id>`; `⚡ M triggered` → `/triggered?agent=<id>` |
| Mobile 375px | PASS | Stacks vertically; no horizontal scroll |
| No console errors | PASS | `browser_console_messages level=error` returned 0 messages across full flow |
| `npx tsc --noEmit` | PASS | 0 errors (baseline preserved) |
| `npm run build:web` | PASS | Built clean in 1.42s |

## Console capture

Across the full interactive run (default load → focus → drawer → search → filter → depth presets → mobile → menu):

```
Total messages: 0 (Errors: 0, Warnings: 0)
```

## Live data caveat (not in scope for Wave 1)

The Wave 0 sample fixture at
`proof/slice-10/wave-0/api-org-chart-v2-sample.json` shows the expected
`reports_to` chain (`meta → joe`, `content → meta`, etc.). The live
endpoint on the running dashboard returns `reports_to: null` for every
agent except `ali`. The page renders whatever the endpoint returns; if
the live data is flat, the chart shows a flat forest.

This is a Wave 0 / data-pipeline concern, not a page concern. The page
correctly handles both the fixture shape and the live shape, including
orphan recovery (any node whose `reports_to` points at a missing parent
is promoted to a root so it never disappears).

## Screenshots

All saved under `proof/slice-10/wave-1/screenshots/`:

- `01-default-load.png` — default expansion, depth-2 visible
- `02-focus-joe.png` — focus mode after clicking Joe's title
- `03-drawer-meta.png` — drawer with Four Rs / Personality / Skills / Owns / LOB sections
- `04-search-trading.png` — search "trading" auto-expands trading-monitor's ancestors and dims the rest
- `04b-search-match-highlighted.png` — match-ring on the trading-monitor card
- `05-filter-human.png` — Human filter chip; AI cards visibly dimmed (still in DOM)
- `05b-filter-human-top.png` — same filter, scrolled to Joe (opacity-100) vs Clawds (opacity-40)
- `06-depth-3.png` — Depth 3 preset full-page render
- `07-mobile-375.png` — mobile 375px stacked layout
- `08-card-menu.png` — card `⋯` menu with Open / Focus / Expand all under / Collapse siblings / Copy link / Edit YAML
- `09-url-focus-meta.png` — `?focus=meta` deep-link landing
