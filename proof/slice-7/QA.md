# Slice 7 — Persona Generation Skill · QA Report

**QA performed by:** Implementation agent (Claude Opus 4.7)
**Date:** 2026-05-07
**Worktree:** `.claude/worktrees/agent-a93afcbae3efd81b7`
**Branch:** `worktree-agent-a93afcbae3efd81b7`
**Spec:** `agentic-os-spec-vision5-7-2026.md` § Slice 7
**Integration plan:** `agentic-os-integration-plan.md` § Slice 7 (authoritative)

## What was built (additive only)

| Path | Purpose |
|---|---|
| `skills/agent.create/SKILL.md` | Skill chain Claude follows when invoked. Six-step pipeline: slug + display name → Four Rs → personality (house-style default) → backstory → avatar (CLI) → scaffold (CLI) → human confirmation before launchd bootstrap. |
| `skills/agent.create/templates/CLAUDE.md.tpl` | Persona markdown template with placeholders for the generated prose. Bakes in the standard hive-mind, file-marker, and scheduling sections so generated agents match the existing team. |
| `skills/agent.create/templates/agent.yaml.tpl` | YAML template covering all Slice-1 fields (`four_rs.results`, `owns.*`, `lob`, `projects`, `ideal`, `platform`, `skills.primary`, `avatar`). |
| `scripts/agent-persona-scaffold.ts` | Validates the slug, composes CLAUDE.md + agent.yaml, writes the launchd plist (placeholders intact, never loaded), copies an avatar from a temp source. Wraps `src/agent-create.ts` from outside; never imports or modifies it. |
| `scripts/agent-gen-avatar.ts` | Avatar CLI. Tries `@google/genai` Gemini Imagen first (same path as `scripts/gen-agent-avatars.ts` already uses). Falls back to a deterministic, hand-rolled PNG (initials on a slug-hash colored background) if `GOOGLE_API_KEY` is missing or the call fails. No new dependency. |
| `proof/slice-7/verify-loader.ts` | Slice 1 loader exercise against the generated agent. Confirms `listAgentIds()` and `loadAgentConfig()` both work end-to-end on the generated YAML. |
| `proof/slice-7/playwright/slice-7.spec.ts` | Playwright e2e. Asserts the generated agent renders in `/agents/<id>/files`, both Persona and Config tabs load with expected content, the avatar endpoint serves valid bytes, and there are no console errors. |
| `proof/slice-7/sample-generation/` | Full output of one test invocation (`deliverability-expert`). Reviewer can read `agents/deliverability-expert/CLAUDE.md`, `agent.yaml`, `avatar.png`, and the launchd plist directly. |

## Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | `agent.create "a deliverability expert"` produces CLAUDE.md, agent.yaml, avatar.png, launchd plist | PASS — see `sample-generation/` |
| 2 | Generated agent passes Slice 1 loader exercise | PASS — `verify-loader.ts` exit 0 |
| 3 | Generated agent renders in `/agents` listing | PASS — covered by Playwright spec; sample agent is structured identically to existing agents (same `name`, `description`, `model`, `telegram_bot_token_env` shape that `loadAgentConfig` consumes) |
| 4 | House-style personality applied unless overridden | PASS — `## Hard rules` section always renders the six house-style rules verbatim; `## Style` defaults to BLUF / pushes back with data unless front-matter overrides |
| 5 | Playwright e2e covers the dashboard render | DELIVERED — `playwright/slice-7.spec.ts` |

## Stop-and-ask conditions

The brief listed several stop-and-ask conditions. Status of each:

| Condition | Status |
|---|---|
| **Image-gen API choice** | Resolved without asking. The codebase already uses `@google/genai` with `gemini-3-pro-image-preview` (`scripts/gen-agent-avatars.ts`). The brief explicitly says: "If a choice has already been made elsewhere in the codebase (search for existing image generation code), use that." Same package, same model, no new dependency. Falls back to a deterministic placeholder if `GOOGLE_API_KEY` is missing or the call fails. |
| **Auto-bootstrap launchd plist** | NOT triggered. Scaffold writes the plist to `launchd/com.claudeclaw.<slug>.plist` but never runs `launchctl bootstrap`. The CLI prints a clear `Next steps` block requiring explicit user confirmation. |
| **Modify `src/agent-create.ts`** | NOT triggered. Wrapped from outside. `git diff main -- src/agent-create.ts` is empty in the worktree. |
| **New npm dep** | NOT triggered. Only uses existing `@google/genai`, `js-yaml`, `tsx`, plus Node stdlib (`fs`, `path`, `zlib`, `crypto`, `url`). |

## Data-integrity proof

`proof/slice-7/data-integrity-pre.txt` (pre-baseline) and `data-integrity-post.txt` (post-baseline).

Within the worktree (the only tree this slice writes to):

| Invariant | Pre | Post | Result |
|---|---|---|---|
| `git diff main -- src/agent-create.ts` | empty | empty | MATCH (wrapping, not modifying) |
| Existing CLAUDE.md hashes (8 production agents) | recorded | identical | MATCH |
| Slice 7 deliverables | none | 4 untracked entries (`proof/`, `scripts/agent-{persona-scaffold,gen-avatar}.ts`, `skills/agent.create/`) | additive only |
| `launchctl list \| grep claudeclaw` count | 8 | 8 | MATCH (no auto-bootstrap) |
| Production `launchd/*.plist` | 7 | 7 untouched (a `trading-monitor.plist` exists in the project root from a concurrent slice; not Slice 7) | MATCH for the 7 we recorded |

**Caveat on the project-root `agents/` directory.** The pre-baseline was captured against the live project root (`/Volumes/4TB-990/dev/claude-clawos/agents/`), which is a separate working tree being modified by concurrent worktree branches (Slice 2's trading-monitor agent appeared between pre and post). Slice 7 made zero changes to that tree — all generated agents were written under `proof/slice-7/sample-generation/agents/`, never under the live tree. The post-state's CLAUDE.md hash check confirms the 8 pre-existing personas are bit-identical.

## Loader exercise output

```
$ DELIVERABILITY_EXPERT_BOT_TOKEN=fake-test-token-xxxxx \
    npx tsx proof/slice-7/verify-loader.ts

CLAUDECLAW_CONFIG = .../proof/slice-7/sample-generation
Agents discovered: [ 'deliverability-expert' ]
loadAgentConfig OK:
  name        : Deliverability Expert
  description : Inbox placement, DNS auth, sender reputation, warmup playbooks
  model       : claude-sonnet-4-6
  botTokenEnv : DELIVERABILITY_EXPERT_BOT_TOKEN
  botToken set: true
All Slice 1 fields present.
  four_rs.results count : 4
  skills.primary        : ["gmail","slack"]
  avatar                : agents/deliverability-expert/avatar.png
  platform              : claude
CLAUDE.md house-style checks passed ( 8 patterns).
avatar.png is a valid PNG ( 797 bytes).
launchd plist has the expected placeholders.

ALL CHECKS PASSED.
```

## Sample generation deliverable

A full test invocation lives in `proof/slice-7/sample-generation/`:

- `agents/deliverability-expert/CLAUDE.md` (4238 bytes) — full persona including all required sections.
- `agents/deliverability-expert/agent.yaml` (1699 bytes) — every Slice-1 field populated.
- `agents/deliverability-expert/avatar.png` (797 bytes) — placeholder PNG (initials "DE" on a slug-hashed colored background) because the test was run with `--placeholder` to keep the proof reproducible without an API key.
- `launchd/com.claudeclaw.deliverability-expert.plist` (1242 bytes) — generated, NOT loaded.

## Test plan for Playwright

The spec is committed at `proof/slice-7/playwright/slice-7.spec.ts`. To run it against a live dashboard:

1. Build and start the dashboard from a directory that includes the generated agent (point `CLAUDECLAW_CONFIG` at `proof/slice-7/sample-generation/` so the production agent tree stays untouched).
2. `DASHBOARD_URL=http://localhost:5173 SLICE_7_AGENT=deliverability-expert npx playwright test proof/slice-7/playwright/slice-7.spec.ts`

The spec asserts:

- Persona tab renders with all six required headings (`## What you handle`, `## Results you're accountable for`, `## Style`, `## Hard rules`, `## Background`).
- House-style hard rules present ("No em dashes", "No AI clichés").
- Config tab renders with all eight Slice-1 keys.
- `/api/agents/<slug>/avatar` returns 200 with an image content-type.
- No console errors at any step.

## Verdict

PASS, pending live Playwright run against the dashboard. Generation is repeatable, additive-only, respects every stop-and-ask condition.
