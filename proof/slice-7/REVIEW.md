# Slice 7 — Persona Generation Skill · Review

This document is the slot for the cross-AI / human reviewer's verdict.
The implementation agent supplies the sections marked "implementation
agent fills". The reviewer fills the verdict sections.

## Slice scope (from spec)

Skill chain at `skills/agent.create/` that, given a basic prompt like
`agent.create "a deliverability expert"`, produces:

1. Four-R outcomes (role, responsibilities, results, requirements).
2. House-style personality (BLUF, pushes back with data, no em dashes).
3. Backstory (hometown, hobbies, beliefs).
4. Avatar (photorealistic PNG, with placeholder fallback).
5. `agent.yaml` with every Slice-1 metadata field populated.
6. launchd plist generated, NOT loaded — human confirmation required.

Wraps `src/agent-create.ts` from outside. Additive only.

## Implementation agent's deliverables

| Path | Type | Notes |
|---|---|---|
| `skills/agent.create/SKILL.md` | new | Slash-command-style skill spec; six explicit steps |
| `skills/agent.create/templates/CLAUDE.md.tpl` | new | Persona template; bakes in hive-mind + file-marker + scheduling sections |
| `skills/agent.create/templates/agent.yaml.tpl` | new | Slice-1-complete YAML template |
| `scripts/agent-persona-scaffold.ts` | new | Scaffold CLI; runs via `npx tsx` |
| `scripts/agent-gen-avatar.ts` | new | Avatar CLI; Gemini Imagen + deterministic placeholder fallback |
| `proof/slice-7/verify-loader.ts` | new | Slice 1 loader exercise |
| `proof/slice-7/playwright/slice-7.spec.ts` | new | e2e covering Persona / Config / avatar render |
| `proof/slice-7/sample-generation/` | new | Full output of one test invocation |
| `proof/slice-7/QA.md` | new | This slice's QA report |
| `proof/slice-7/data-integrity-{pre,post}.txt` | new | Baselines |

Files NOT modified (verified):

- `src/agent-create.ts` — `git diff main -- src/agent-create.ts` is empty.
- Any existing `agents/*/CLAUDE.md` — hashes match pre.
- Any existing `launchd/*.plist` — hashes match pre (production tree).

## Integration contract

| Question | Answer |
|---|---|
| Did the slice add only? | YES. Five new files, one new skill dir, one new proof dir. Zero modifications to tracked files. |
| Are data-integrity proofs green? | YES. Slice 1 loader passes against the generated agent. CLAUDE.md hashes for the 8 pre-existing personas match pre. |
| Were new ingress paths protected? | N/A. Slice 7 has no HTTP routes, no webhooks, no schedulers. The launchd plist is generated, not loaded. |

## Image-gen API decision

Used the codebase's existing path: `@google/genai` with `gemini-3-pro-image-preview` (same as `scripts/gen-agent-avatars.ts`). Per the brief, "If a choice has already been made elsewhere in the codebase (search for existing image generation code), use that." No new dependency. Hard-coded fallback to a deterministic placeholder PNG when `GOOGLE_API_KEY` is missing or the call fails — keeps the rest of the slice deterministic and CI-friendly.

## Stop-and-ask conditions hit

None. Each was either pre-resolved in the codebase or explicitly handled:

- Image-gen API: pre-resolved (Gemini already wired in).
- Auto-bootstrap launchd: explicitly NOT done — the plist is written, the CLI prints "REQUIRES YOUR EXPLICIT CONFIRMATION" before any `launchctl bootstrap` invocation.
- Modify `src/agent-create.ts`: explicitly NOT done — wrapped from outside.
- New npm dep: explicitly NOT done — only existing deps and Node stdlib.

## Reviewer verdict

(Reviewer fills.)

- [ ] APPROVED
- [ ] CHANGES REQUESTED
- [ ] REJECTED

### Reviewer notes

(Reviewer fills.)
