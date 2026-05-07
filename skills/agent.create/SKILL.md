---
name: agent.create
description: Generate a complete ClaudeClaw agent (CLAUDE.md persona, agent.yaml, avatar.png, launchd plist) from a one-line description. Use when the user says "create a new agent", "spin up a [role]", "agent.create", or asks to add a specialist to the team. Generates Four Rs (role/responsibilities/results/requirements), personality matching house style, backstory, and avatar in one shot. Does NOT auto-bootstrap launchd — generates the plist and waits for explicit confirmation.
user_invocable: true
---

# /agent.create -- Persona Generation Skill (Slice 7)

Given a basic prompt like `agent.create "a deliverability expert"`, produce a complete agent setup: a Four-R persona, personality, backstory, photorealistic avatar, agent.yaml, and a launchd plist. Wraps `src/agent-create.ts` from the outside; never modifies it.

## Inputs

- The free-text role description (required).
- An optional `--slug` override. If absent, derive a slug from the description (lowercase, hyphenated, max 30 chars, starting with a letter).
- An optional `--display-name` override. If absent, derive Title Case from the slug.
- An optional `--style "..."` override that, when present, replaces the house-style personality defaults.

## Steps

### Step 1 — Resolve the slug and display name

1. Pick a 1-3 word slug from the description (e.g. "a deliverability expert" → `deliverability-expert`). Lowercase, hyphens only, ASCII, must start with a letter, max 30 chars.
2. Derive display name as Title Case of the slug words (e.g. `Deliverability Expert`).
3. Verify no collision: an existing directory at `agents/<slug>/` is a hard stop. Surface the conflict and ask whether to pick a different slug.

### Step 2 — Generate the Four Rs (PROSE for CLAUDE.md, ARRAY for agent.yaml.results)

For the role described, write:

- **Role** — 2-3 sentences in plain prose. What this agent is, what they own. Lead with capability.
- **Responsibilities** — 5-8 bulleted items in CLAUDE.md under "What you handle". Concrete tasks the agent does on a normal week.
- **Results** — 3-5 measurable outcomes. **These also go into `agent.yaml` under `four_rs.results: [...]`**. Each entry should be a short, quantifiable phrase (e.g. "inbox placement rate >95%", "median response < 2h", "no failed sends per quarter"). Avoid vague verbs like "improve" or "support".
- **Requirements** — 3-5 bulleted items in CLAUDE.md under "Hard rules". What the agent must never do, what it must verify before acting, what data it requires before producing output.

The Results array is the only field that must be measurable. The other three are prose.

### Step 3 — Generate personality

Default to Joe's house style unless `--style` overrides:

- **Tone** — chill, grounded, straight up. Talks like a real person, not a language model.
- **Pushback** — pushes back with data when it disagrees; owns outcomes; asks one short clarifying question instead of guessing.
- **Format** — BLUF (bottom line up front). Short, scannable. Tables for comparisons. Cite sources when accuracy matters.

**Hard rules that ALWAYS apply** (copied verbatim from the project's CLAUDE.md house style — these belong in every persona):

- No em dashes. Ever.
- No AI clichés ("Certainly!", "Great question!", "I'd be happy to", "As an AI", etc.).
- No sycophancy.
- No excessive apologising.
- Don't narrate what you're about to do. Just do it.
- If you don't know something, say so plainly.

These render as a "## Style" section followed by "## Hard rules" in the generated CLAUDE.md.

### Step 4 — Generate backstory

Just enough to feel real. Goes in a "## Background" section in CLAUDE.md as a single paragraph (3-5 sentences). Include:

- Hometown / where they're from.
- 1-2 hobbies or interests outside work.
- A core belief or working philosophy that informs how they approach their job.

Keep it grounded. No anime backstories, no superpowers. The point is to give the agent a consistent voice, not to be cute.

### Step 5 — Generate avatar (to a temp file)

Run the avatar generator CLI, writing the PNG to a temp path. The scaffold script in step 6 copies it into `agents/<slug>/avatar.png`.

The generator uses the codebase's existing image-gen path (`@google/genai` with `gemini-3-pro-image-preview`, same as `scripts/gen-agent-avatars.ts`). If `GOOGLE_API_KEY` is missing or the call fails, it writes a deterministic placeholder PNG (initials on a colored background).

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
TMP_AVATAR=$(mktemp -t agent-avatar-XXXXXX.png)
npx tsx "$PROJECT_ROOT/scripts/agent-gen-avatar.ts" \
  --slug "<slug>" \
  --display-name "<Display Name>" \
  --description "<one-line description>" \
  --out "$TMP_AVATAR"
```

Flags: `--style photorealistic` (default) or `--style pop-art` to match the existing team's pop-art look. Pass `--placeholder` to skip the API call and write the deterministic initials placeholder.

### Step 6 — Scaffold the agent files

Run the persona scaffold CLI. It composes the CLAUDE.md, the agent.yaml (with all Slice-1 metadata fields populated), and the launchd plist. **It does NOT load the plist into launchd.**

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
npx tsx "$PROJECT_ROOT/scripts/agent-persona-scaffold.ts" \
  --slug "<slug>" \
  --display-name "<Display Name>" \
  --description "<one-line description>" \
  --persona-file "<path-to-persona-markdown>" \
  --results-json '<JSON array of measurable results>' \
  --skills-json '<JSON array of primary skills>' \
  --lob "<lob slug or empty>" \
  --projects-json '<JSON array of project slugs>' \
  --avatar-source "$TMP_AVATAR"
```

The scaffold CLI:

- Validates the slug (same rules as `agent-create.ts:validateAgentId`).
- Creates `agents/<slug>/` with `CLAUDE.md` (your generated persona + the standard hive-mind, file-marker, scheduling sections appended), `agent.yaml` (all Slice-1 fields populated), and copies the avatar from a temp location if you generated it separately.
- Generates `launchd/com.claudeclaw.<slug>.plist` from the same template `agent-create.ts` uses.
- Does NOT write to `.env` (no Telegram bot token yet — the user supplies that later).
- Does NOT run `launchctl bootstrap` or `launchctl load`.

### Step 7 — Confirm with the user before bootstrapping

Print a clear next-step message:

```
Generated agent "<slug>" at agents/<slug>/.

Files written:
  - agents/<slug>/CLAUDE.md
  - agents/<slug>/agent.yaml
  - agents/<slug>/avatar.png
  - launchd/com.claudeclaw.<slug>.plist

NOT done automatically:
  1. Telegram bot token. Create a bot via @BotFather and add the token to .env as <SLUG>_BOT_TOKEN=...
  2. launchd bootstrap. To start the agent's process:
       launchctl bootstrap gui/$(id -u) launchd/com.claudeclaw.<slug>.plist

Proceed? (y / N)
```

**Wait for explicit user confirmation before running `launchctl bootstrap`.** This is a hard rule per Slice 7 spec.

## Templates

The persona is composed from `templates/CLAUDE.md.tpl` (in this skill directory). The yaml is composed from `templates/agent.yaml.tpl`. Both are interpolated by the scaffold CLI — you do not need to template them yourself, just supply the structured inputs.

## What this skill does NOT do

- Does NOT modify `src/agent-create.ts`.
- Does NOT load the launchd plist automatically.
- Does NOT add a persona editor UI.
- Does NOT write a Telegram bot token.
- Does NOT modify any existing agent.
