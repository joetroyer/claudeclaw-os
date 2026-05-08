# Slice 10 Wave 2 — OrgChartV2 visual polish · QA log

Wave 1 shipped the page functionally, but visually it presented as a stack
of full-width rectangles with letter-only avatars, no skill chips, no LOB
tag, and no visible tree connectors. Wave 2 closes those gaps without
touching endpoints, routing, focus-trap, or 44px work.

## Scope

Visual-only refactor of `web/src/pages/OrgChartV2.tsx` plus four
keystroke-tier rules in `web/src/styles/main.css`. No new endpoints, no
new dependencies, no schema or API change.

## Card redesign

- Fixed 380px width on `sm` breakpoints and up; full-width on mobile.
- Header row: chevron · 40px avatar · (name · type badge · menu pill).
- Role line below the header, line-clamp-2.
- Skill chips: top 3 from `node.skills.primary`, with `+N` overflow
  affordance that opens the drawer for full skill list. Hidden when the
  array is empty (today's live data has empty `primary` for most nodes).
- LOB tag: `LOB <slug>` rendered low-emphasis under the chips.
  Hidden when `node.lob` is null.
- Footer split into two visual rows separated from the body by a
  `border-t`: nav-counts (reports / AI Employees) on top, cadence
  (`N sched`, `N trig`) below.

## Avatars

`AgentAvatar` was already capable of `<img>` first / initials fallback.
This wave bumps the size from 36 → 40px and lets the avatar be its own
button (clicking the avatar opens the agent profile, same as before).
For both `type === 'human'` and `type === 'ai'` the resolver hits
`/api/agents/:id/avatar`; humans without an uploaded avatar fall through
to coloured initials, which is the same path AI nodes take.

## Tree connector rails

The `.org-chart-children` container draws a 1px vertical rail on its
left edge using a `::before` pseudo-element. Each child card is wrapped
in `.org-chart-child-rail`, whose `::before` draws a 16px horizontal
stub at avatar centerline. The last child in each container masks the
rail's tail with a 3px `color-bg` overlay for a clean L-shape on the
final sibling. No JS, no SVG.

## Outbound link affordances

- Cadence buttons (`N sched`, `N trig`) get `cursor-pointer`, hover
  flips text to `--color-accent`, and a `→` glyph fades in on hover.
- Type badge surfaces a subtle `Filter` icon at 8px on hover.
- Card menu trigger now renders inside an elevated circle (`rounded-full
  bg-color-elevated`) so it reads as a button, not a stray icon.
- Footer divider gives the body content a clear card edge.

## Filter bar

- Search becomes a MissionControl-style input: leading magnifying
  glass, transparent except for `color-card` background, accent focus
  border, absolute-positioned clear-X.
- Type chips lose the leading filter glyph (the labels stand alone).
- LOB and project selects align with MissionControl's select pattern.
- Depth presets get an `uppercase tracking-wider` label and tighter
  spacing.

## Live verification

The dashboard backend wasn't running in this worktree (no `.env` token),
so visual-check was driven against the Vite dev server with mocked
endpoints. A representative tree (Joe → Ali, Meta → Comms, Content,
Research) was injected via Playwright's `page.route` API. Screenshots
captured at 1280px and 375px live in `screenshots/`.

Console errors: 1 (unrelated SSE MIME complaint from the mocked
`/api/chat/stream`). Zero errors related to OrgChartV2.

## TypeScript baseline

`npx tsc --noEmit` → 0 errors.
`cd web && npm run build` → clean (one chunk-size warning, pre-existing,
unrelated to this slice).

## Out of scope (still scoped for Wave 3)

- YAML editor — menu still toasts "Edit YAML coming in Slice 10 Wave 3"
- Cross-card highlight when filter chip is hovered
- Multi-select on filters

## Files touched

- `web/src/pages/OrgChartV2.tsx` (card layout + toolbar slim + connector classes)
- `web/src/styles/main.css` (rail pseudo-elements, scoped to `.org-chart-children` / `.org-chart-child-rail`)
- `proof/slice-10/wave-2/playwright/wave-2.spec.ts` (visual-polish assertions)
- `proof/slice-10/wave-2/visual-check.mjs` (one-shot screenshot driver)
- `proof/slice-10/wave-2/screenshots/*.png` (1280px desktop + 375px mobile)
