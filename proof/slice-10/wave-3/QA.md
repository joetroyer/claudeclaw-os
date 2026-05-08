# Slice 10 Wave 3 — QA

## What changed

- Frontend (`web/src/pages/OrgChartV2.tsx`): the "Edit YAML coming in
  Slice 10 Wave 2" toast stub is replaced with `YamlEditorPanel`, an
  inline drawer body that lets the user edit an agent or human's YAML
  directly. Pre-fills from the new endpoints, validates on type with
  `js-yaml`, atomically writes on Save, refetches `/api/org-chart-v2`,
  and closes the drawer.
- Backend (`src/dashboard.ts`): four new auth-gated endpoints —
  `GET/PUT /api/agents/:id/yaml` and `GET/PUT /api/humans/:id/yaml`.
  All four reuse the existing `/api/*` token middleware (no new auth
  surface), enforce `^[a-z0-9_-]+$` ids, cap the body at 64 KB, and
  resolve the agent path via `resolveAgentDir(id) + '/agent.yaml'` so
  path traversal is structurally impossible.

## How to reproduce manually

1. `npm run dev` (Hono dashboard at :3141 + Vite at :5173).
2. Open `http://localhost:5173/org-chart-v2?token=$DASHBOARD_TOKEN`.
3. Click an agent's role line (e.g. "Coordinator. Splits work…") to
   open the drawer. The drawer's section header reads `FOUR RS`.
4. Click the `FOUR RS` header (or open the per-card overflow menu and
   pick `Edit YAML…`). The drawer body swaps to the YAML editor.
5. The textarea pre-fills with `agents/<id>/agent.yaml` from the wire.
   The status row says "YAML valid" while the document parses cleanly.
6. Add a comment line, click `Save`. A success toast pops up, the
   drawer closes, and the org chart refetches in the background.
7. Re-open the same drawer + editor. The new comment is on disk.

## Validation matrix

| Surface | Test |
|--------|------|
| GET happy path | `dashboard.yaml-edit.test.ts > GET /api/agents/:id/yaml > returns the raw yaml text…` |
| GET unknown id (404) | same describe block |
| GET invalid id (400) | same describe block |
| GET no token (401) | same describe block |
| PUT happy path + node shape | `… > PUT /api/agents/:id/yaml > writes the new yaml…` |
| PUT invalid yaml (400) | `… > returns 400 for unparseable yaml` |
| PUT missing required (400) | `… > returns 400 when name/description missing` |
| PUT > 64 KB (400) | `… > returns 400 when yaml exceeds 64KB` |
| PUT no token (401) | `… > returns 401 without a token` |
| Path traversal rejected | `… > rejects path-traversal ids…` |
| Human GET / PUT same matrix | mirrored describe blocks |

`npx vitest run src/dashboard.yaml-edit.test.ts` — 22 tests, all pass.

## Out of scope

- Wave 2 (visual polish) is in a sibling worktree. This patch
  intentionally avoids `<NodeCard>` markup changes so a merge with
  Wave 2 stays mechanical.
- No DB schema changes, no new migrations.
- No new npm dependencies. The textarea is plain HTML; validation
  uses `js-yaml`, already a root dep.
