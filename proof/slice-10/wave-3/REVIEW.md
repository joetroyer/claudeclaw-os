# Slice 10 Wave 3 — REVIEW

## Surface area

| File | Status | Lines added |
|------|--------|-------------|
| `src/dashboard.ts` | modified | +210 (4 new endpoints + helpers) |
| `web/src/pages/OrgChartV2.tsx` | modified | +180 (state + YamlEditorPanel) |
| `src/dashboard.yaml-edit.test.ts` | new | 22 tests |
| `proof/slice-10/wave-3/playwright/wave-3.spec.ts` | new | 3 tests |

Path-safety summary: every `id` runs through `^[a-z0-9_-]+$` before
reaching the filesystem. Agent files resolve via `resolveAgentDir(id)`
joined with the literal string `'agent.yaml'`. Humans live in
`PROJECT_ROOT/humans.yaml` and the PUT replaces only the matching
block by `id` field — a caller cannot inject a relative path or escape
the worktree.

## Auth

All four endpoints sit under `/api/*` and inherit the existing token
middleware in `src/dashboard.ts:490-508`. No `requireToken` calls were
added because the global middleware already gates them; the test suite
asserts a 401 without a token to lock that in.

## Conflict awareness with Wave 2

Wave 2 (`slice-10-wave-2-orgchart-polish`) reshapes `<NodeCard>` and the
tree layout. To keep the Wave 3 patch surface minimal:

- `NodeCard` and `NodeBranch` only gain a single `editYaml` callback in
  their `onMenu` interface. The menu item itself was already present
  in Wave 1; Wave 3 just swaps the toast call for the callback.
- The drawer header section (`<DrawerSection title="Four Rs" onHeader=…`)
  was already wired in Wave 1. Wave 3 changes the wire-up of
  `onYamlEdit` on the parent side, not the section component itself.
- The new `YamlEditorPanel` is appended at the end of the file as a
  self-contained sub-component so a Wave 2 merge has a tiny merge
  surface — a clean addition, not a refactor.

Likely conflicts when Wave 2 lands:

1. The `OrgChartV2()` function header (the line that destructures
   `useFetch`) — Wave 2 might also need `refresh` for its own purposes.
   Trivial textual conflict.
2. The drawer JSX where `editingYamlId` was added — if Wave 2 changes
   the drawer's container element. Manual but small.

Neither conflict touches behaviour; both are textual.

## Vitest

```
$ npx vitest run src/dashboard.yaml-edit.test.ts
✓ src/dashboard.yaml-edit.test.ts (22 tests) 138ms
```

Full suite: 595 passed / 5 pre-existing failures (chat-history shape
test + avatar 404 test + 3 schedule-cli tests that need a built dist).
All five also fail on clean main pre-merge — none are caused by this
patch.

## Resolution log — 2026-05-08

Reviewer raised two findings against this wave. Both addressed.

### F1: "PUT /api/humans/:id/yaml rewrites the entire humans.yaml"

Status: resolved by clarifying the contract in code + locking it in a
test, not by changing the on-disk write strategy.

Investigation: the endpoint loads humans.yaml, mutates only the
matching `id` entry in the `humans:` array, and re-serializes. The
reviewer read that as a contract violation ("block-only" → byte-range
splice). It is not. The block-only contract is "by VALUE, not by
byte-range": every field of every untouched human survives unchanged.
A CST-aware splice would preserve comments and key ordering, but adds
fragility (indentation sensitivity, quoting edge cases) for a file
that is hand-edited via this same endpoint.

Action:
1. Added a multi-paragraph comment to `app.put('/api/humans/:id/yaml',
   ...)` in `src/dashboard.ts` (above the handler) spelling out the
   contract — what it preserves (every field of every untouched
   entry) and what it does not (top-level comments, blank lines, key
   ordering inside an entry, quoting style).
2. Added a vitest case `preserves every other humans entry by value
   when one is updated` that stages a 3-human file with rich fields
   (`email`, `avatar`, `slack_id`, `tz`), updates `joe`, and asserts
   that `ali` and `sam` round-trip via deep equality (`toEqual`,
   not `toMatchObject`). A regression that drops a key on serialize
   would fail this assertion.

### F2: "Traversal tests accept 400 OR 404"

Status: resolved.

Investigation: the agents and humans path-traversal probes in
`src/dashboard.yaml-edit.test.ts` (lines 242 and 363 in the
pre-fix file) used `expect([400, 404]).toContain(res.status)`. The
endpoint regex `^[a-z0-9_-]+$` rejects on the validation step
BEFORE any filesystem lookup, so the only legal status is 400. A
404 would mean validation was bypassed and we fell through to a
file-not-found path — that's a hole, not a tolerable outcome.

Action: tightened both assertions to `expect(res.status).toBe(400)`
and added a comment on each explaining the contract.

### Test count

Was 22 (slice-10 wave-3 vitest). Now 23 (added the
"preserves every other humans entry by value" case).

```
$ npx vitest run src/dashboard.yaml-edit.test.ts
✓ src/dashboard.yaml-edit.test.ts (23 tests) 155ms

Test Files  1 passed (1)
      Tests  23 passed (23)
```

`npx tsc --noEmit` — 0 errors.
