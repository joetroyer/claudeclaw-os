# Slice 10 Wave 0 — QA Report (template)

**QA performed by:** _<main thread orchestrator>_
**Reviewed at:** _<timestamp>_
**Worktree:** `.claude/worktrees/agent-a28d14d40290d1d13`
**Branch:** `worktree-agent-a28d14d40290d1d13`
**Reviewer verdict:** _<from REVIEW.md>_

## Summary

Slice 10 Wave 0 lands the foundation for the new OrgChartV2 page:

- Two new YAML fields documented in `agents/schema.md`: `type` and
  `reports_to`.
- Migration script `scripts/migrate-org-v2.ts` adds them across every
  tracked `agent.yaml(.example)` plus `humans.yaml`. Idempotent.
- New `GET /api/org-chart-v2` endpoint surfaces both humans + AI
  agents as a single flat array, carrying the new fields plus
  enough runtime stats (running, today_turns, scheduled_count,
  triggered_count) for the Wave 1 UI.
- Slice 3 endpoints (`/api/org-chart/*`) unchanged. Slice 3 reader
  (`src/org-chart.ts`) untouched.
- No CLAUDE.md edits. No loader edits. No new npm deps.

## Migration applied

Runs captured in:

- `migration-dry-run.txt`        — dry-run pre-migration
- `migration-output.txt`         — real run + idempotency rerun
- `migration-third-dry-run.txt`  — third dry-run (everything up-to-date)
- `migration-fixture-output.txt` — migration applied to fixture tree

| Run | Files scanned | Migrated | Already up-to-date |
|---|---|---|---|
| Dry-run #1 (pre) | 6 | 6 | 0 |
| Real run | 6 | 6 | 0 |
| Idempotent rerun | 6 | 0 | 6 |
| Dry-run #2 (post) | 6 | 0 | 6 |

`humans.yaml` patched on first run (joe + ali); idempotent on rerun.

## Data-integrity invariants (pre vs post)

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `agents/*/CLAUDE.md` SHA-256 hashes | recorded | identical | MATCH |
| `src/agent-config.ts` SHA-256 | `82bf2e80…` | `82bf2e80…` | MATCH |
| `src/org-chart.ts` git diff | empty | empty | MATCH |
| `git diff main -- agents/*/CLAUDE.md` | empty | empty | MATCH |

Files: `data-integrity-pre.txt`, `data-integrity-post.txt`.

## New endpoint shape

`api-org-chart-v2-sample.json` — captured by driving `readOrgChartV2()`
against a fixture tree that mirrors all 8 production agents +
`humans.yaml`.

Total nodes: **10** (joe, ali, meta, comms, content, research, ops,
clawds, trading-monitor, goldbot-labs).

The reports_to tree:

```
joe (root)
├── meta
│   ├── content, research, ops, comms, clawds
├── trading-monitor
└── goldbot-labs

ali → joe
```

Per-node fields verified in the sample:

- `id`, `type` ("ai" | "human"), `name`, `role`, `reports_to`
- `lob` (null for humans), `projects`, `skills.primary`
- `owns.{scheduled_tasks, triggered_tasks, n8n_workflows, watchers}`
- `four_rs.{role, responsibilities, results, requirements}` — empty
  defaults for fields that live in CLAUDE.md prose; `results`
  populated for trading-monitor where the production YAML carries it.
- `personality.{tone, pushback, format}` — empty defaults (CLAUDE.md
  prose).
- `avatar` (null when YAML has empty string)
- `running` (null for humans, `true` for fixture AI nodes)
- `today_turns` (null for humans, demo values per fixture)
- `scheduled_count` (counts owns.scheduled_tasks)
- `triggered_count` (counts owns.triggered_tasks)

## Existing /api/org-chart/* unchanged

Live capture at `api-existing-org-chart-live.txt`:

- `GET /api/org-chart/humans` — same `{humans: [...]}` shape.
- `GET /api/org-chart/lobs` — same `{lobs: [...]}` shape.
- `GET /api/org-chart/agents` — same fields per agent (`id`, `name`,
  `description`, `lob`, `projects`, `ideal`, `platform`,
  `four_rs_results`, `skills_primary`, `owns`, `avatar`). No `type` or
  `reports_to` added.
- `GET /api/org-chart/workload` — same `{window_days, overload_threshold,
  workload}` shape.

`GET /api/org-chart-v2` returns 404 against the live dashboard today
because the running server hasn't been rebuilt to include the new
route. That's expected — the route lands when Joe restarts the
dashboard after merge.

## Browser smoke (deferred)

Same situation as Slice 1: the live dashboard server still serves the
pre-merge build. Once the dashboard is rebuilt + restarted, run:

```bash
TOKEN=$(grep '^DASHBOARD_TOKEN' .env | cut -d= -f2 | tr -d '"')
curl -sS "http://localhost:3141/api/org-chart-v2?token=$TOKEN" | jq .
```

…and append the response to this QA file. The fixture-driven sample
already proves the reader shape end-to-end.

## Verdict

_<set after reviewer signs off in REVIEW.md>_

## Files of record

- `proof/slice-10/wave-0/REVIEW.md`               — reviewer verdict
- `proof/slice-10/wave-0/QA.md`                   — this file
- `proof/slice-10/wave-0/data-integrity-pre.txt`  — pre-migration baseline
- `proof/slice-10/wave-0/data-integrity-post.txt` — post-migration state
- `proof/slice-10/wave-0/migration-dry-run.txt`   — dry-run output
- `proof/slice-10/wave-0/migration-output.txt`    — real-run output + idempotent rerun
- `proof/slice-10/wave-0/migration-third-dry-run.txt`        — confirms idempotency
- `proof/slice-10/wave-0/migration-fixture-output.txt`       — migration on fixture
- `proof/slice-10/wave-0/api-org-chart-v2-sample.json`       — endpoint payload sample
- `proof/slice-10/wave-0/api-existing-org-chart-live.txt`    — Slice 3 endpoints unchanged
- `proof/slice-10/wave-0/org-tree-decisions.md`              — reports_to rationale
- `proof/slice-10/wave-0/build-fixture-and-sample.ts`        — fixture builder
- `proof/slice-10/wave-0/read-fixture.ts`                    — fixture reader
- `proof/slice-10/wave-0/sample-endpoint.ts`                 — driver against worktree state
- `agents/schema.md`                              — schema documentation
- `scripts/migrate-org-v2.ts`                     — migration script
- `src/org-chart-v2.ts`                           — new reader module
- `src/dashboard.ts`                              — `/api/org-chart-v2` route

## Open follow-ups (non-blocking)

1. Rebuild + restart the dashboard, capture live `/api/org-chart-v2`
   curl response, append to this file.
2. Wave 1 unblocked: build the OrgChartV2 page UI consuming this
   endpoint.
3. Optional: re-run the migration against the live `agents/*/agent.yaml`
   files once Joe is ready to promote the new schema into the
   production directory (the script already supports
   `tsx scripts/migrate-org-v2.ts --root /path/to/repo`).
