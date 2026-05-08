# Slice 10 Wave 4 — OrgChartV2 horizontal layout · QA artefacts

## What changed

A total UX overhaul of OrgChartV2 to match the reference in `LinkedIn —
I Have 150 AI Employees (Org Chart Tour).md`. Six headline shifts:

1. **Synthesized `main` agent** is always present in `/api/org-chart-v2`
   even though no `agents/main/agent.yaml` exists on disk — mirrors the
   `listAgentSliceMetadata` pattern at `src/agent-config.ts:281-294`.
2. **Horizontal sibling layout.** Cards fan out in a row below their
   parent, connected by an org-chart bus + short verticals. Replaces
   the Wave 2 vertical-rail tree.
3. **Compact 220 px card form factor.** Drops from Wave 2's 380 px so
   4-5 fit in a row at 1280 px. Two-row card height max.
4. **Four-Rs preview on the card.** First responsibility line shows
   below the role; truncated to one line. Hidden when empty.
5. **Default expand depth 3** (was 2). Joe + his reports + their
   reports visible on first paint.
6. **Auto-fit zoom** when the natural tree width exceeds the canvas.
   Mirrors Callan's reference (her 0:36s frame zooms the whole 17-node
   chart so it fits one screen). Min ratio 0.42; below that we let the
   canvas scroll horizontally.

## Live verification

The dashboard backend wasn't running in this worktree, so visual-check
was driven against the Vite dev server with mocked endpoints (a tiny
Node http server at `:3141` returns the full ClaudeClaw roster — joe +
8 humans + 9 AI agents including the synthesized `main`). Screenshots
captured at 1280 × 900 and 375 × 812 live in `screenshots/`.

| File                                  | What it shows                                 |
|---------------------------------------|-----------------------------------------------|
| `01-default-depth-3-1280x900.png`     | Default first paint: depth 3 expansion, all 18 nodes visible end-to-end vertically |
| `03-focus-mode-meta.png`              | Focus mode on Meta — only the Meta subtree, full-size cards |
| `04-drawer-meta.png`                  | Drawer for Meta with Four Rs / Skills / Owns / 5 reports |
| `05-mobile-375x812.png`               | Mobile fallback — vertical stack, full-width cards |

Console errors during visual check: 0 related to OrgChartV2 (one
pre-existing SSE MIME complaint from a mocked `/api/chat/stream`).

## Card metrics (measured at 1280 × 900)

- **Card width:** 220 px (was 380 px in Wave 2).
- **Card height:** ~125 px on a populated card (avatar 32 + name row
  + role + first-resp + skills row + LOB pill on the same row +
  footer with counts/cadence).
- **Visible cards on default depth-3 view:** 18 cards (joe + 8 humans
  + 9 AI agents inc. synthesized main).
- **Auto-scale ratio for the seed fixture:** 0.42 (clamped — the
  natural 3 436 px width exceeds the visible canvas even at min ratio,
  so the canvas allows ~530 px of horizontal scroll for the spillover).

## Tree connector technique

CSS pseudo-elements on `.org-chart-child`. No new deps, no SVG. See
`web/src/styles/main.css` (Slice 10 Wave 4 block):

- `.org-chart-trunk` — 1 px × 12 px solid div between a parent card and
  the bus below.
- `.org-chart-child::before` — short vertical drop above each child.
- `.org-chart-child::after` — half-bus slice across the top of each
  child; first / last / only-child variants trim the bus.
- `.org-chart-children-row` — flex row of sibling subtrees.

Mobile (<640 px) media query falls back to a Wave 2-style left-edge
rail tree because the horizontal bus would compress to invisible at
that width.

## Wave 1+2+3 contracts preserved

- [x] **Focus trap** on drawer open — `useFocusTrap` hook unchanged.
- [x] **44 × 44 touch targets** on toolbar buttons, depth presets,
      drawer interactives, menu, avatar, type badge, drawer chips.
      The compact card footer uses 44 × 44 hit areas with tight visual
      content (icon + count) inside.
- [x] **URL state** `?focus=` and `?expand=` round-trip on every
      focus / expand change.
- [x] **localStorage persistence** of expansion intact (`STORAGE_KEY =
      claudeclaw.org-chart-v2.expansion`).
- [x] **YAML editor** in drawer still works — Wave 3 endpoints
      (`/api/agents/:id/yaml`, `/api/humans/:id/yaml`) untouched, the
      YamlEditorPanel component unchanged.

## TypeScript + build

- `npx tsc --noEmit` → 0 errors.
- `cd web && npm run build` → clean (one chunk-size warning,
  pre-existing, unrelated to this slice).
- `npx vitest run src/org-chart-v2.test.ts` → 4 / 4 pass.
- Full vitest run → 5 pre-existing failures (dashboard.contract +
  schedule-cli) unrelated to this slice; verified by checking the
  failures exist on the prior HEAD too.

## Files touched

- `src/org-chart-v2.ts` — synthesized `main` agent in the reader.
- `src/org-chart-v2.test.ts` — two new assertions covering main.
- `web/src/pages/OrgChartV2.tsx` — full rewrite of NodeBranch +
  NodeCard + auto-fit zoom + canvas centring.
- `web/src/styles/main.css` — replaced Wave 2 rail CSS with the
  horizontal bus + mobile fallback.
- `proof/slice-10/wave-4/playwright/wave-4.spec.ts` — Wave 4
  assertions.
- `proof/slice-10/wave-4/visual-check.mjs` — one-shot screenshot
  driver against the Vite dev server.
- `proof/slice-10/wave-4/screenshots/*.png` — 1280 × 900 desktop +
  375 × 812 mobile + focus mode + drawer.
- `proof/slice-10/wave-4/QA.md` — this file.

## Out of scope

- Endpoint shapes (`/api/org-chart-v2`, `/api/agents/:id/yaml`,
  `/api/humans/:id/yaml`) — unchanged.
- v1 `OrgChart.tsx` — untouched.
- `agent.yaml` / `humans.yaml` schema — unchanged. Avatar + first
  responsibility are populated by the orchestrator, not by Wave 4.
