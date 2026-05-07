# Slice 1 — Reviewer Verdict

> Filled in by the reviewer agent (Codex / Gemini). Verdict line at the bottom.

## Acceptance Criteria

- [ ] 1. Migration is idempotent (run twice → second run produces no diff).
- [ ] 2. `git diff agents/*/CLAUDE.md` is empty.
- [ ] 3. Every existing field in every `agent.yaml(.example)` is preserved bit-identical.
- [ ] 4. `agent-config.ts` re-loads every migrated YAML without error.
- [ ] 5. AgentFiles UI renders new fields without errors.
- [ ] 6. Playwright e2e passes (or spec is committed for manual MCP execution).
- [ ] 7. All data-integrity proofs match pre to post.

## Test Coverage

- _What's covered:_
- _What's not, why:_

## Security Check

- _Auth boundaries:_
- _Input validation:_
- _Secret handling:_

## Out-of-Scope Drift Check

- _List any changes outside the slice contract; each justified or rejected:_

## Console Errors Smoke

- _Reviewer ran the UI themselves and pasted the console output (zero errors required):_

## Integration Section (per `agentic-os-integration-plan.md`)

- _Did the slice add only, or did it modify existing tables/files/code?_
- _Are the data-integrity proofs all green?_
- _Were any new ingress paths (HTTP routes, webhooks, file mutations) protected?_

## Verdict

Verdict: PENDING REVIEW
