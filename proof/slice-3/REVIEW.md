# Slice 3 — Code Review

**Reviewer:** _(to be filled by independent reviewer — different model family from implementer per Slice 1 precedent)_
**Reviewed at:** _(pending)_
**Worktree:** /Volumes/4TB-990/dev/claude-clawos/.claude/worktrees/agent-a8df5c79d9d35ae09

## Status

`Verdict: PENDING REVIEW`

## Acceptance criteria

- [ ] Org chart page loads at `/org-chart` with three tabs (Hierarchy, Analytics, Ideal vs Active).
- [ ] Hierarchy tab walks LOB → project → resource. Drawer shows Four Rs (`four_rs.results`), primary skills, and `owns.*` for agents; `owns_lobs` / `owns_projects` for humans.
- [ ] Analytics tab shows per-agent workload counts pulled from `mission_tasks` and `scheduled_tasks`. Overloaded agents are flagged. Suggested-breakout text appears when `total > threshold`.
- [ ] Ideal vs Active tab filters by `agent.yaml`'s `ideal: true` flag and visually distinguishes ideal-only agents.
- [ ] All four new endpoints under `/api/org-chart/` are GET-only.
- [ ] No npm dependencies added.
- [ ] No agent YAMLs modified.
- [ ] No DB schema modified (only an additive read helper in `src/db.ts`).
- [ ] No existing API endpoint modified.

## Integration contract (additive-only)

- [ ] Pre/post data-integrity proofs match exactly (`diff data-integrity-{pre,post}.txt` returns 0 except for the timestamp banner).
- [ ] `git diff <worktree-base>..HEAD -- agents/` is empty.
- [ ] `git diff <worktree-base>..HEAD -- store/claudeclaw.db.schema` is empty (no schema file exists; equivalent: schema sha256 in pre/post matches).
- [ ] No write surface added: `grep -nE "INSERT|UPDATE|DELETE|writeFileSync|fs\.write|fs\.appendFile|fs\.unlink" src/org-chart.ts` returns nothing.
- [ ] `mission_tasks` count unchanged pre/post.

## Test coverage

- Covered: …
- Not covered: …

## Security

- …

## Out-of-scope drift

- …

## Console errors smoke

- …

## Verdict

_(reviewer to fill: APPROVED / CHANGES REQUESTED)_
