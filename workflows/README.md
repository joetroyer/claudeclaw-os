# Workflows (Slice 6 — Multi-Agent Workflows)

Workflows chain mission_tasks across agents with handoffs, runtime
deny-rules, and a council pattern for consensus-required work.

## Schema

A workflow definition is a YAML file at `workflows/{slug}.yaml` matching:

```yaml
slug: example-bugfix          # required, must match filename
title: Bug fix → QA verify    # required, human-readable
description: |                # optional
  Two-stage sequential workflow: dev fixes the bug, QA verifies.

# Council consensus default. Per orchestrator decision (Slice 6 brief),
# defaults to "majority" when omitted on a council stage.
default_consensus: majority   # majority | unanimous | threshold

# Optional safe-path allowlist applied to every stage in this workflow.
# Stage rows can extend with their own allowed_paths.
allowed_paths:
  - tasks.md
  - memory/
  - plans/
  - evidence/
  - docs/
  - proof/

stages:
  - name: dev-fix             # required
    type: sequential          # sequential | council
    agent: ops                # required for sequential; ignored for council
    prompt: |                 # required, supports {{previous_output}}
      Fix the bug described below.
      {{input}}
    on_failure:
      retries: 1
      escalate_to: meta       # agent slug, or 'human' for a triage task

  - name: qa-verify
    type: sequential
    agent: research
    prompt: |
      Verify the fix produced in the previous stage.
      Previous output:
      {{previous_output}}
    on_failure:
      retries: 0
      escalate_to: human

# A council stage example:
#   - name: arch-review
#     type: council
#     agents: [research, ops, meta]      # required for council
#     consensus: majority                # overrides default_consensus
#     prompt: |
#       Review the proposed architecture independently.
#       {{input}}
#     on_failure:
#       retries: 0
#       escalate_to: human
```

## Templating

Two placeholders are interpolated into stage prompts:

- `{{input}}` — the workflow's original payload (CLI argument).
- `{{previous_output}}` — the output of the previous sequential stage,
  or a JSON-encoded list of council-member outputs for council stages.

If the placeholder is absent, the prompt is sent verbatim.

## Council consensus rules

- `majority` — strictly more than 50% of members must verdict APPROVED.
- `unanimous` — every member must verdict APPROVED.
- `threshold` (future) — N-of-M; not implemented in slice 6.

A council member's verdict is parsed from the trailing line of its
output: `VERDICT: APPROVED` or `VERDICT: REJECTED` (case-insensitive).
If absent, the verdict is `UNKNOWN` and counts as a rejection.

## Failure + escalation

When a stage fails (mission_task status `failed` or `cancelled`), the
runner retries up to `on_failure.retries` times. After exhaustion, it
creates a new mission_task assigned to `on_failure.escalate_to` (or
unassigned for `'human'`) with the workflow history attached.

Escalation does NOT spawn another workflow. It is a plain mission_task
visible in Mission Control.

## Runtime enforcement

When a stage spawns its mission_task, the workflow runner injects an
in-process Claude Code SDK `PreToolUse` hook that denies `Edit`/`Write`
on paths NOT in `allowed_paths`. The hook is per-spawn — solo
mission_tasks (not part of a workflow) get NO hook injected, so their
behavior is identical to today.
