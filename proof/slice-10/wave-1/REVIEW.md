# Slice 10 Wave 1 — OrgChartV2 · Review packet

## Branch / commit

- Branch: `main` (work landed directly on the worktree branch)
- Source files:
  - `web/src/pages/OrgChartV2.tsx` (NEW, ~1100 lines)
  - `web/src/App.tsx` (route wiring)
  - `web/src/lib/routes.ts` (sidebar + command palette entry)
- Endpoint untouched: `/api/org-chart-v2` is consumed read-only.

## What to look at first

1. **`OrgChartV2.tsx`** — single-file page. Sections from top to bottom:
   - Types
   - localStorage helpers
   - Tree building (`buildTree`, `descendantIds`, `ancestorIds`, `nodesMatching`)
   - URL state helpers (`readUrlState`, `writeUrlState`)
   - Page component (state, effects, handlers)
   - Toolbar
   - `NodeBranch` (recursive tree)
   - `NodeCard` (collapsed card + `⋯` menu)
   - `NodeDrawer` (Four Rs / Personality / Skills / Owns / LOB / reports / n8n)
2. **State model**:
   - Expansion: `Set<string>` of node ids; persisted to localStorage and URL
   - Focus: single id; persisted to URL only
   - Filters: type / LOB / project; transient (not persisted)
   - Search: 200ms debounced; auto-expands ancestors of matches; clearing restores prior state via a snapshot
3. **Outbound links**: see the `// Outbound linking` table in the spec —
   every cadence badge, skill tag, owned task, and LOB chip is either a
   navigate or a no-op stub with toast.

## Decisions worth flagging

- **localStorage key is global**, not per-agent. If Slice 11 introduces
  multi-tenant workspaces, key the expansion set by `workspaceName`.
- **Focus mode is exclusive of depth presets**. Clicking a depth preset
  cancels focus — it's a global view operation. Confirmed against the
  spec: depth presets "fan out", which implies a global view.
- **Search and filter chips are NOT mirrored to URL.** They're
  view-helpers, not bookmarkable state. If reviewer wants them
  bookmarkable too, add to `writeUrlState`.
- **Edit YAML is stubbed** — clicking the Four Rs section header or
  selecting "Edit YAML…" from the `⋯` menu shows a toast: "Edit YAML
  coming in Slice 10 Wave 2".
- **Skill / agent profile routes don't exist yet.** Clicking a skill tag
  navigates to `/skills/<id>` (which falls through to the Placeholder
  page). Avatar click goes to `/agents/<id>` — same treatment. These are
  forward-wired for the routes that come later.
- **Card `⋯` menu uses outside-click + Escape to close.** No portal — it
  positions absolutely off the button. No keyboard arrow-nav inside the
  menu yet (plain buttons; tab order is correct).
- **Animation budget**: cards transition opacity / ring with Tailwind's
  default 150ms. Expand/collapse is instantaneous (no height-animation —
  matches the Notion / Linear feel and avoids layout-thrash on long
  trees).

## Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run build:web` | passes (1.42s) |
| Browser console errors | 0 across full interactive run |
| Mobile 375px | renders, no horizontal scroll |

See `QA.md` for the per-criterion walkthrough and screenshots.

## Open questions / punted

1. **Live endpoint vs fixture mismatch.** The live `/api/org-chart-v2`
   returns `reports_to: null` for everyone except `ali`, but the Wave 0
   fixture sample shows `meta → joe`, `content → meta`, etc. The page
   handles both correctly, but the reviewer may want to verify whether
   the endpoint is supposed to be deriving `reports_to` from agent.yaml
   `reports_to:` fields and isn't.
2. **No keyboard nav arrows for tree traversal.** Cards are focusable
   buttons (title, subtitle, badge, cadence, menu) and ESC closes the
   drawer, so a11y is reachable. Up/Down arrow tree-walk would be a
   future enhancement.
3. **Animation is opacity-only.** The spec called for "150ms grows
   downward" expand. I left expand/collapse as instant DOM toggle —
   height-animating recursive trees is a foot-gun (off-screen children
   hold layout while animating). Easy to retrofit if reviewer disagrees.
4. **`Edit YAML…` is a toast stub.** Will land in Slice 10 Wave 2 per
   the spec.
5. **Old OrgChart page is preserved.** New page lives at
   `/org-chart-v2`, parallel to `/org-chart`. Sunset of v1 is out of
   scope here.

## Acceptance checklist (from spec)

- [x] `/org-chart-v2` route renders the page; default state shows depth-2 tree
- [x] Click node title → focus mode zooms; click background → unzoom
- [x] Depth presets 1/2/3/All work
- [x] Search auto-expands path to matches
- [x] Filter chips for type (human/AI) collapse non-matching, dim them
- [x] URL state `?focus=meta` and `?expand=...` work both as input and output
- [x] localStorage persists expansion across reloads
- [x] Drawer renders Four Rs / personality / skills / owns / LOB
- [x] Each card shows `🗓 N scheduled · ⚡ M triggered` (count from owns, default 0)
- [x] Cadence badge clicks navigate correctly
- [x] Mobile (375px) renders without horizontal scroll
- [x] No console errors during full flow
- [x] `npx tsc --noEmit` clean
- [x] Web build passes (`cd web && npm run build`)
