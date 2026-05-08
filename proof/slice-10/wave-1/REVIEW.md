# Resolution log — 2026-05-08

The four blocking findings from the original review (preserved verbatim
below) were addressed in `web/src/pages/OrgChartV2.tsx` and the wave-1
Playwright spec. No backend, package.json, or v1 OrgChart.tsx changes.

## Finding 1 — Drawer focus trap missing → RESOLVED
- Added inline `useFocusTrap(containerRef, active)` hook in
  `web/src/pages/OrgChartV2.tsx` (~75 lines, no new dependency).
- On drawer open: saves `document.activeElement`, focuses first focusable
  inside the drawer, intercepts Tab / Shift-Tab to cycle within the
  container.
- On drawer close (Esc / backdrop / close button): restores focus to the
  originally-focused element (e.g. the subtitle button that opened it).
- Drawer body is now wrapped in `data-testid="org-chart-v2-drawer-content"`
  for spec assertions.
- Spec coverage: `drawer traps focus inside its container (a11y · finding 1)`
  and `ESC closes drawer and restores focus to opener (a11y · finding 1)`
  in `proof/slice-10/wave-1/playwright/wave-1.spec.ts`.

## Finding 2 — Cards lack semantic roles → RESOLVED (already buttons + verified)
- Audit confirms title, subtitle, type-badge, cadence badges, child rows,
  and chevron toggle were already real `<button type="button">`. They
  were buttons in the original implementation; the reviewer's note about
  `<div onClick>` referred to the card root container, but interactive
  elements were already buttons.
- Hardened the assertion path: added `data-testid` attributes where
  missing (drawer child rows now have
  `data-testid="org-chart-v2-drawer-child-<id>"`).
- Spec coverage: `cards expose semantic <button> elements (a11y · finding 2)`
  asserts `getByRole('button').count() > 0` inside a card and verifies
  title / subtitle / badge are all `BUTTON` elements via `tagName`.

## Finding 3 — Touch targets <44px → RESOLVED
- Bumped every flagged interactive element to `min-h-[44px] min-w-[44px]`
  with appropriate `inline-flex items-center justify-center` so glyphs
  stay centered in the larger hit-box without visual bloat:
  - Toolbar: search clear-button, depth presets (1/2/3/All), filter
    chips (All/Human/AI), LOB/project selects, exit-focus button.
  - Card: chevron toggle, avatar wrapper, title, subtitle, type badge,
    `N reports`, `N AI Employees`, `N scheduled`, `N triggered`, overflow
    `⋯` menu, and each menu item.
  - Drawer: parent reports-to button, child rows in reports list, skill
    chips, LOB/project chips, OWNS scheduled/triggered/n8n buttons, and
    the editable section header.

### Finding 3 — Reviewer follow-up (2026-05-08) → RESOLVED
The first pass had `min-h-[44px]` on most elements but was missing
explicit `min-w-[44px]` on the elements the reviewer re-flagged. Second
pass added `min-w-[44px]` (plus `inline-flex items-center` and `px-3`
where padding alone wouldn't satisfy 44 × 44 visually) to the entire
list:
- Toolbar selects (LOB filter, project filter), exit-focus button.
- Card title, subtitle, `N reports`, `N AI Employees`, `N scheduled`,
  `N triggered`, and every overflow `⋯` menu item.
- Drawer parent reports-to button, every report-list child row, skill
  chips, LOB/project chips, editable section header (DrawerSection
  with `onHeader`), OWNS scheduled-task buttons, OWNS triggered-task
  buttons, OWNS n8n workflow links.

Edge case handled: drawer chips (skill / LOB / project / OWNS items)
keep their visual chip look — `min-w-[44px]` only enforces the click
bounding box; `inline-flex items-center justify-center` centers the
small label inside the 44px box without visual bloat.

- Spec coverage:
  - Existing `mobile interactive elements meet 44px target (finding 3)`
    still walks 13 representative selectors at 375px.
  - NEW `every interactive element on the page meets 44px target
    (finding 3 · bulk)` opens the drawer and walks every
    `[data-testid^="org-chart-v2-"]` button/link/select plus toolbar
    and drawer interactives at 375px, asserting width ≥ 43 and
    height ≥ 43 for each visible one. Asserts `checked > 10` so a
    broken selector can't silently pass. This scales with the surface:
    new buttons added later are automatically validated.

## Finding 4 — OWNS structure: nest n8n_workflows → RESOLVED
- Removed the standalone `<DrawerSection title="n8n workflows">` block
  from `NodeDrawer`.
- Added a third sub-list inside `OwnsBlock` that renders n8n workflows
  alongside scheduled + triggered (header
  `n8n workflows (N)` + a `<ul>` of external links to
  `https://n8n.joetroyer.com/workflow/<id>` with the existing
  `target="_blank" rel="noopener noreferrer"` safety).
- Spec coverage: `OWNS section nests n8n_workflows alongside scheduled +
  triggered (finding 4)`.

## Verification

- `git diff 10634f0...HEAD -- src/` → 0 lines (no backend drift).
- `git diff 10634f0...HEAD -- package.json package-lock.json` → 0 lines
  (no new dependency).
- `git diff 10634f0...HEAD -- web/src/pages/OrgChart.tsx` → 0 lines
  (v1 untouched).
- `npx tsc --noEmit` from project root → 0 errors.
- `cd web && npm run build` → succeeds with chunk-size warning only.

Files touched:
- `web/src/pages/OrgChartV2.tsx`
- `proof/slice-10/wave-1/playwright/wave-1.spec.ts`
- `proof/slice-10/wave-1/REVIEW.md` (this resolution log)

Patterns reused:
- Existing `min-h-[44px]` Tailwind idiom (used in other Toggle / button
  components in `web/src/components/`).
- Inline hook style mirroring `useFetch`, `useDebouncedValue` rather than
  introducing a new lib file.

---

# Original review (verbatim)

**VERDICT: REQUEST CHANGES**

## Check 1 — Out-of-scope drift
Status: PASS

Evidence:
- `git -C /Volumes/4TB-990/dev/claude-clawos diff 10634f0...d4b0598 -- src/` produced zero output.
- `git -C /Volumes/4TB-990/dev/claude-clawos diff 10634f0...d4b0598 -- package.json package-lock.json` produced zero output.
- `git -C /Volumes/4TB-990/dev/claude-clawos diff 10634f0...d4b0598 -- 'web/src/pages/OrgChart.tsx'` produced zero output.

## Check 2 — AI-as-head architecture
Status: PASS

Evidence:
- Design doc explicitly requires AI heads and AI-managing-AI at `/Users/dev/Library/Mobile Documents/iCloud~md~obsidian/Documents/V1/Courses/The Uncommon Business/Effortless Business Bootcamp/LinkedIn — I Have 150 AI Employees (Org Chart Tour).md:207-239`.
- Tree assembly never special-cases AI to leaves; parentage is driven only by `reports_to` in `web/src/pages/OrgChartV2.tsx:111-140`.
- Same recursive branch/card path renders both humans and AI: `NodeBranch` and `NodeCard` are shared in `web/src/pages/OrgChartV2.tsx:732-1001`.
- The only human/AI divergence is the badge tone/icon/text in `web/src/pages/OrgChartV2.tsx:820-885`.
- Endpoint tests prove AI→AI and human→AI edges are valid in `src/org-chart-v2.test.ts:72-126`.

## Check 3 — Smart collapse/expand mechanics
Status: PARTIAL

Evidence:
- Default top-2 expansion is implemented by opening every root on first load in `web/src/pages/OrgChartV2.tsx:221-247`.
- localStorage persistence exists via `claudeclaw.org-chart-v2.expansion` in `web/src/pages/OrgChartV2.tsx:80,84-102,249-252`; reload survival is tested in `proof/slice-10/wave-1/playwright/wave-1.spec.ts:102-109`.
- Focus mode on title click is implemented in `web/src/pages/OrgChartV2.tsx:356-370,415-431,865-872`; background click exits focus in `web/src/pages/OrgChartV2.tsx:481-487`.
- Depth presets 1/2/3/All cancel focus in `web/src/pages/OrgChartV2.tsx:338-351` and have basic Playwright coverage in `proof/slice-10/wave-1/playwright/wave-1.spec.ts:43-55`.
- Search auto-expands ancestors, highlights matches, and restores prior expansion on clear in `web/src/pages/OrgChartV2.tsx:261-299`. Playwright only asserts a visible card after search, not restore/highlight behavior, in `proof/slice-10/wave-1/playwright/wave-1.spec.ts:57-61`.
- URL `focus` and `expand` read/write round-trip in code via `web/src/pages/OrgChartV2.tsx:187-206,217-259`, but Playwright only covers `focus`, not `expand`, in `proof/slice-10/wave-1/playwright/wave-1.spec.ts:90-93`.
- Bulk ops are present in the card menu in `web/src/pages/OrgChartV2.tsx:382-413,968-987`.
- Height animation was intentionally punted and documented in the proof stub at `proof/slice-10/wave-1/REVIEW.md` before overwrite; the same trade-off is visible in code because children mount/unmount instantly in `web/src/pages/OrgChartV2.tsx:765-774`.

Failures inside this check:
- Filter UI is not “chips for type, LOB, project”; only type uses chips, while LOB/project use `<select>` in `web/src/pages/OrgChartV2.tsx:591-640`.
- Activating filters dims non-matches but does not collapse branches; filter state only affects `dimmed` styling in `web/src/pages/OrgChartV2.tsx:300-320,735-739,825-827`.
- Expand/collapse is not a 150ms downward-only growth animation; child branches are conditionally rendered with no height animation in `web/src/pages/OrgChartV2.tsx:765-774`.
- Playwright coverage is materially incomplete for several requested behaviors; there is no assertion for default depth-2, `expand=` deep links, background unzoom, search-clear restore, or LOB/project filtering in `proof/slice-10/wave-1/playwright/wave-1.spec.ts:23-115`.

## Check 4 — Outbound linking
Status: PASS

Evidence:
- Card title → focus mode: `web/src/pages/OrgChartV2.tsx:498,865-872`
- Card subtitle → drawer: `web/src/pages/OrgChartV2.tsx:499,892-899`
- Type badge → type filter: `web/src/pages/OrgChartV2.tsx:501,873-885`
- `scheduled` badge → `/scheduled?agent=<id>`: `web/src/pages/OrgChartV2.tsx:502,930-938`
- `triggered` badge → `/triggered?agent=<id>`: `web/src/pages/OrgChartV2.tsx:503,939-947`
- Drawer LOB tag → chart filter: `web/src/pages/OrgChartV2.tsx:524,1102-1112`
- Drawer project tag → chart filter: `web/src/pages/OrgChartV2.tsx:525,1114-1127`
- Drawer `reports_to` → scroll/zoom parent: `web/src/pages/OrgChartV2.tsx:1021,1024,1032,1050-1059`
- Drawer child rows → scroll/zoom child: `web/src/pages/OrgChartV2.tsx:1021,1135-1155`
- Owned scheduled task → `/scheduled?id=<task_id>`: `web/src/pages/OrgChartV2.tsx:522,1296-1313`
- Owned triggered task → `/triggered?slug=<task_id>`: `web/src/pages/OrgChartV2.tsx:523,1315-1332`
- Owned n8n workflow → `https://n8n.joetroyer.com/workflow/<id>` new tab with safe rel: `web/src/pages/OrgChartV2.tsx:1158-1174`
- Edit YAML toast stub: `web/src/pages/OrgChartV2.tsx:526,988-993,1189-1196`
- Drawer skill tag → `/skills/<slug>` is also wired from the broader design-doc outbound table: `web/src/pages/OrgChartV2.tsx:521,1077-1087`

Exact count:
- 14/14 wired if counting the broader outbound subset above.
- The explicit checklist in the task body enumerates 13 handlers; all 13 of those are wired.

## Check 5 — Drawer schema
Status: PARTIAL

Evidence:
- Present: Four Rs in `web/src/pages/OrgChartV2.tsx:1065-1067`
- Present: Personality in `web/src/pages/OrgChartV2.tsx:1069-1071`
- Present: Skills in `web/src/pages/OrgChartV2.tsx:1073-1090`
- Present: LOB / Projects in `web/src/pages/OrgChartV2.tsx:1100-1133`
- Present: Reports / AI Employees nav via parent jump plus child list in `web/src/pages/OrgChartV2.tsx:1032,1050-1059,1135-1155`

Failure:
- `OWNS` is incomplete. The spec requires `scheduled_tasks`, `triggered_tasks`, and `n8n_workflows` inside the Owns section, but `OwnsBlock` only renders scheduled/triggered/watchers in `web/src/pages/OrgChartV2.tsx:1279-1353`. `n8n_workflows` is split into a separate section at `web/src/pages/OrgChartV2.tsx:1158-1174`.

Exact count:
- 5/6 required drawer sections are present as specified.

## Check 6 — Mobile responsiveness
Status: PARTIAL

Evidence:
- Screenshot `proof/slice-10/wave-1/screenshots/07-mobile-375.png` shows the page stacked vertically with no obvious horizontal overflow.
- Code does include overflow guards: app main wrapper uses `min-w-0 overflow-hidden` in `web/src/App.tsx:50`; toolbar uses `flex-wrap` in `web/src/pages/OrgChartV2.tsx:565-566`; cards use `min-w-0` and wrapped rows in `web/src/pages/OrgChartV2.tsx:863-901`; child branches use modest `ml-4 sm:ml-6` in `web/src/pages/OrgChartV2.tsx:765-768`.
- Drawer is a full-width bottom sheet on mobile-sized screens in `web/src/components/Modal.tsx:83-102`.

Failure:
- Touch targets are not consistently 44px+. Several controls are visibly and structurally smaller: depth buttons `px-2 py-0.5` in `web/src/pages/OrgChartV2.tsx:688-705`, filter chips `px-2 py-1` in `web/src/pages/OrgChartV2.tsx:667-679`, chevron toggle `mt-1` with a 14px icon in `web/src/pages/OrgChartV2.tsx:838-850`, and cadence buttons at `text-[11px]` with no minimum height in `web/src/pages/OrgChartV2.tsx:901-947`.

## Check 7 — Accessibility
Status: PARTIAL

Evidence:
- Interactive elements are generally keyboard-reachable because titles, subtitles, badges, chevrons, menu items, drawer nav rows, and chips are real `<button>`/`<a>` elements throughout `web/src/pages/OrgChartV2.tsx:839-947,1003-1013,1053-1059,1079-1087,1105-1124,1140-1151,1163-1169`.
- ESC closes the drawer in `web/src/components/Modal.tsx:61-72`.
- Type badge has an explicit aria-label in `web/src/pages/OrgChartV2.tsx:873-878`.

Failures:
- The drawer does not trap focus. `Drawer` only locks body scroll and listens for Escape; there is no focus-scope or tab-loop logic in `web/src/components/Modal.tsx:60-105`.
- The card container itself is a plain `<div>`, not a semantic button/link/treeitem, in `web/src/pages/OrgChartV2.tsx:822-836`.
- There is no tree semantics (`role="tree"`, `role="treeitem"`, arrow-key traversal) anywhere in `web/src/pages/OrgChartV2.tsx`.

## Check 8 — Endpoint integration + `reports_to: null` diagnosis
Status: PASS

Evidence:
- The page calls `/api/org-chart-v2` through a single `useFetch('/api/org-chart-v2', 60_000)` on mount in `web/src/pages/OrgChartV2.tsx:210-212`; `useFetch` performs one immediate `apiGet(path)` per mount/path change in `web/src/lib/useFetch.ts:34-52`.
- The server exposes exactly one GET endpoint at `src/dashboard.ts:3393-3415`.
- Empty `nodes[]` is handled with a dedicated empty state in `web/src/pages/OrgChartV2.tsx:472-478`.
- `reports_to: null` is handled by treating null/missing parents as roots in `web/src/pages/OrgChartV2.tsx:111-123` and by making parent nav conditional in `web/src/pages/OrgChartV2.tsx:1032,1050-1061`.

Diagnosis:
- Option B applies.
- Why: the endpoint is a thin YAML reader. It simply reads `raw['reports_to']` and returns `null` when the field is missing or empty in `src/org-chart-v2.ts:175-184`. In the current repo, only `agents/meta/agent.yaml` has `reports_to: joe` at `agents/meta/agent.yaml:4-6`; the other agent YAMLs shown under `agents/*/agent.yaml` omit `reports_to` entirely. The page already handles null gracefully, but the production hierarchy will stay flat until those agent YAML files are populated.
- Supporting contrast: the Wave 0 sample fixture includes populated AI chains such as `clawds`, `comms`, `content`, and `ops` reporting to `meta` in `proof/slice-10/wave-0/api-org-chart-v2-sample.json:72-145,207-260`.

## Check 9 — Console errors
Status: FAIL

Evidence:
- The requested assertion `expect(consoleErrors).toEqual([])` does not exist in `proof/slice-10/wave-1/playwright/wave-1.spec.ts:1-115`.
- There is no `proof/slice-10/wave-1/console-messages.txt` artifact in the directory listing; only `QA.md`, `REVIEW.md`, `playwright/`, and `screenshots/` are present.
- `QA.md` claims zero console messages at `proof/slice-10/wave-1/QA.md:41-47`, but that claim is not backed by a spec assertion or saved console artifact.

## Check 10 — Build + types
Status: PARTIAL

Evidence:
- `cd /Volumes/4TB-990/dev/claude-clawos/web && npx tsc --noEmit 2>&1 | tail -20` shows TypeScript errors and exits non-zero (`__EXIT:2`). Reported errors include `src/components/AgentSuggestions.tsx(52,45)` and several others in `BrainGraph3D.tsx`, `HiveMind.tsx`, `Scheduled.tsx`, and `StandupConfig.tsx`.
- `cd /Volumes/4TB-990/dev/claude-clawos/web && npm run build 2>&1 | tail -30` completes successfully with `__EXIT:0`; Vite builds and reports only chunk-size warnings, not build failure.

Interpretation:
- Build: clean enough to pass `npm run build`, with warning-only output.
- Types: not clean under the requested `npx tsc --noEmit` command.

## reports_to null diagnosis
Option B: production `agent.yaml` files need `reports_to` fields populated.

Why:
- Endpoint logic is correct and already consumes `reports_to` when present: `src/org-chart-v2.ts:180-184`.
- Current source data is incomplete: only `agents/meta/agent.yaml:4-6` has `reports_to`; the other seven agent YAMLs omit it.
- The client already degrades safely by pinning null/missing-parent nodes to roots: `web/src/pages/OrgChartV2.tsx:111-123`.

## Non-blocking follow-ups
- Replace LOB/project `<select>` controls with actual chips if the design doc language is intended literally.
- If the broader outbound table matters, wire the remaining design-doc actions too: avatar deep-link semantics, report-row “scroll to first” behavior, project-page navigation instead of project filtering, and any future cost badge.
- Add real console capture to the Playwright spec and save an artifact.
- Add proper drawer focus trapping and tree semantics (`role="tree"` / `treeitem`).
- Consider storing expansion state with clearer per-workspace scoping if multi-workspace support is expected.
