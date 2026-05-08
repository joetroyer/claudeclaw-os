# Slice 6 — Multi-Agent Workflows · Review (template)

**Reviewer:** TBD (Codex preferred — different model family for true second opinion)
**Slice:** Slice 6 — Multi-Agent Workflows (Agent Teams Pattern)
**Branch:** `worktree-agent-a82fcff2d8385a787`
**Status:** PENDING

## Integration section (REQUIRED — see integration plan)

- [ ] Did the slice add only, or did it modify existing tables/files/code?
- [ ] Are the data-integrity proofs all green?
- [ ] Were any new ingress paths (HTTP routes, webhooks, file mutations) protected?

## Acceptance criteria checklist

- [ ] Sequential 2-stage workflow runs end-to-end (mission_tasks +2)
- [ ] 3-agent council reaches majority consensus (mission_tasks +3)
- [ ] Force-fail beyond retries → escalation mission_task created
- [ ] PreToolUse hook blocks attempted Edit on production files
- [ ] Solo (non-workflow) mission_tasks unaffected
- [ ] Workflow state visible in dashboard with stage breakdown
- [ ] QA Gate green (vitest, console clear)

## Code review focus areas

1. **PreToolUse hook scoping.** Verify the deny hook lives only inside
   `spawnWorkflowStage` and is passed per-call via the SDK `hooks`
   option. Confirm `runAgent` (in `src/agent.ts`) is unchanged.
2. **mission_tasks schema.** Confirm `git diff main -- src/db.ts` shows
   only additive `CREATE TABLE IF NOT EXISTS` for `workflow_runs` and
   `workflow_stages`. No ALTER, no schema mutation on mission_tasks.
3. **Solo path isolation.** Confirm `src/scheduler.ts`, `src/agent.ts`,
   `src/bot.ts`, `src/index.ts` are unchanged.
4. **Workflow YAML loader strictness.** Verify malformed YAML is
   rejected at load time, not silently mis-applied.
5. **Council consensus rule.** Verify `evaluateConsensus` strictly
   enforces "more than half" for majority (ties fail) and "all
   approvals" for unanimous.
6. **Escalation routing.** Verify `on_failure.escalate_to: 'human'`
   creates an unassigned mission_task; named agent slugs are routed.
7. **Stage timeout handling.** Verify the 10-minute per-stage timeout
   aborts cleanly via `AbortController` and records 'aborted/timeout'.

## Verdict template

```
APPROVED — additive only, all proofs green, runtime enforcement scoped
correctly to workflow stages, solo path unaffected.
```

```
REJECTED — see comments inline; specific concerns:
  - <concern 1>
  - <concern 2>
```
