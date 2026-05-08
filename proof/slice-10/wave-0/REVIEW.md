# Slice 10 Wave 0 — Code Review (template)

**Reviewer:** _<assign cross-family reviewer (Codex / Gemini / etc.) before merge>_
**Reviewed at:** _<timestamp>_
**Worktree:** `.claude/worktrees/agent-a28d14d40290d1d13`
**Branch:** `worktree-agent-a28d14d40290d1d13`

## Acceptance criteria

- [ ] `agents/schema.md` documents the two new fields (`type`, `reports_to`)
      under a "Slice 10 additions" section, with the same field-table
      style as the Slice-1 section.
- [ ] `scripts/migrate-org-v2.ts` is idempotent: re-running emits
      "already up-to-date" for every file (see
      `proof/slice-10/wave-0/migration-output.txt`).
- [ ] All 6 tracked `agent.yaml.example` files now have `type: "ai"` +
      `reports_to: <id>` appended in a clearly fenced section.
- [ ] `humans.yaml` has `type: "human"` + `reports_to` per entry
      (joe → "", ali → "joe").
- [ ] `agents/*/CLAUDE.md` byte-identical pre vs post (see
      `data-integrity-{pre,post}.txt` and `git diff main -- 'agents/*/CLAUDE.md'`).
- [ ] `src/agent-config.ts` byte-identical pre vs post.
- [ ] `src/org-chart.ts` (Slice 3 reader) untouched.
- [ ] Existing `/api/org-chart/*` response shape unchanged (see
      `api-existing-org-chart-live.txt`).
- [ ] New `/api/org-chart-v2` returns a flat array of nodes — humans
      first, AI agents second — each carrying `type` and `reports_to`
      (sample: `api-org-chart-v2-sample.json`).
- [ ] `running`, `today_turns`, `scheduled_count`, `triggered_count`
      populated correctly per node (humans → null/null/0/0; AI agents
      pull running + today_turns from the dashboard's pid-file probe +
      `getAgentTokenStats`, scheduled/triggered counts from
      `agent.yaml`'s `owns.*` arrays).
- [ ] No new npm dependencies (`git diff main -- package.json package-lock.json`
      is empty).

## Integration contract (additive-only)

- [ ] Migration appends keys; never removes or renames anything.
- [ ] New fields sit in a clearly labelled "Slice 10 Wave 0" section
      at EOF, mirroring the Slice 1 migration's style.
- [ ] No `role`, `responsibilities`, `requirements`, `personality.*`,
      `backstory` fields appear in any YAML — they stay in CLAUDE.md
      prose. The `four_rs` / `personality` subkeys returned by the
      endpoint default to empty so a future Wave can stitch in
      CLAUDE.md prose without changing the wire shape.

## Test coverage

- Covered:
  - Migration dry-run + real run + second-run idempotency
    (`migration-dry-run.txt`, `migration-output.txt`,
    `migration-third-dry-run.txt`).
  - End-to-end shape via fixture + `readOrgChartV2()`
    (`api-org-chart-v2-sample.json`, `read-fixture.ts`,
    `build-fixture-and-sample.ts`).
  - Live shape of existing `/api/org-chart/*` endpoints
    (`api-existing-org-chart-live.txt`).
- Not covered until merge:
  - Live `/api/org-chart-v2` smoke against the running dashboard
    (server has not been rebuilt — request returns 404 today). To
    complete: rebuild + restart the dashboard, then re-curl with
    `?token=...` and append the response to QA.md.

## Security

- The migration only writes within the supplied repo root's
  `agents/` tree and `humans.yaml`. No secrets touched.
- The new endpoint is mounted under the dashboard's existing
  authenticated `/api/*` middleware — same auth surface as
  `/api/org-chart/*`.

## Out-of-scope drift

- No loader (`src/agent-config.ts`), package, or persona-file
  (`agents/*/CLAUDE.md`) drift.
- `src/org-chart.ts` not touched — Slice 3 readers preserved.
- Existing `/api/org-chart/*` routes left as-is.

## Verdict

_<reviewer fills in: APPROVED / CHANGES REQUESTED, with findings>_

## Resolution log — finding "proof sample fabricated"

Reviewer flagged that `api-org-chart-v2-sample.json` was being produced
by `read-fixture.ts`, which manually re-implemented the reader's parse
logic instead of importing `readOrgChartV2()` from `src/org-chart-v2.ts`.
Risk: silent drift between the proof artifact and the live route.

**Fix landed:**

1. `proof/slice-10/wave-0/build-fixture-and-sample.ts` rewritten to
   stage the fixture tree under `CLAUDECLAW_CONFIG` and re-exec itself
   in a child process that imports the REAL `readOrgChartV2()` —
   the child sets `CLAUDECLAW_CONFIG=<fixture>` and intercepts
   `fs.readFileSync` for the single PROJECT_ROOT/humans.yaml path so
   the worktree's humans.yaml doesn't have to be mutated. The captured
   sample is now byte-faithful to the live route.
2. `read-fixture.ts` deleted (no longer needed).
3. `src/org-chart-v2.test.ts` added — two vitest cases that mock
   `./config.js` to redirect PROJECT_ROOT + CLAUDECLAW_CONFIG into a
   tmpdir, stage humans.yaml + 3 agent.yaml fixtures (one human-typed,
   one AI with `reports_to: "joe"`, one AI with `reports_to: "meta"`,
   one AI with no `reports_to` field), and assert the reader's flat-array
   shape + cross-tier tree.
4. `QA.md` updated with a "Fixture handling — production runtime parity"
   section that documents the `CLAUDECLAW_CONFIG`-as-fixture-root pattern,
   matching the existing `resolveAgentDir()` lookup contract.

The "no committed AI agent.yaml" question is resolved by Path 1 in
the brief: the project's runtime contract puts agent.yaml in
`CLAUDECLAW_CONFIG`, only `.example` files ship in the repo. The proof
harness now bootstraps a fixture `CLAUDECLAW_CONFIG` from scratch,
so reviewer's "running the real reader against the committed tree
returns empty" observation is by design.

**Verification commands:**

```
npx tsc --noEmit                                      # 0 errors (unchanged baseline)
npx vitest run src/org-chart-v2.test.ts               # 2 tests pass
npx tsx proof/slice-10/wave-0/build-fixture-and-sample.ts
                                                      # regenerates sample.json via real reader
```
