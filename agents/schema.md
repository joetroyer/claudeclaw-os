# Agent YAML Schema

Every agent has two files in `agents/<id>/`:

- **`CLAUDE.md`** — the persona prose. Role, responsibilities, requirements, personality, backstory, hard rules. Re-read by the Agent SDK on every turn — saves take effect immediately.
- **`agent.yaml`** — structured metadata. Read at process start (and on save → restart). Treats unknown keys as ignorable (`src/agent-config.ts`), so additions are safe.

This document is the single source of truth for what fields are allowed in `agent.yaml`. Anything a slice author wants to surface in queries, dashboards, or rollups goes here. Anything the agent reads as instructions goes in `CLAUDE.md`.

The "Slice" column tracks which expansion slice introduced each field. See `agentic-os-spec-vision5-7-2026.md` and `agentic-os-integration-plan.md` for the build sequence.

## Existing fields (pre-Slice-1, in production)

| Field | Type | Slice | Description |
|---|---|---|---|
| `name` | string | pre-existing | Display name shown in the dashboard, war-room roster, and Telegram. Required. |
| `description` | string | pre-existing | One-line capability summary. Used by the meta agent for routing and shown in agent cards. |
| `telegram_bot_token_env` | string | pre-existing | Name of the env var in `.env` holding this agent's Telegram bot token. Required. |
| `model` | string | pre-existing | Default Claude model id (e.g. `claude-sonnet-4-6`). Override per-chat with `/model`. |
| `obsidian.vault` | string | pre-existing | Optional. Absolute path to the Obsidian vault to auto-inject. |
| `obsidian.folders` | string[] | pre-existing | Folders inside the vault this agent can read + write. |
| `obsidian.read_only` | string[] | pre-existing | Folders this agent can only read. |
| `mcp_servers` | string[] | pre-existing | Optional MCP server allowlist. |
| `warroom_tools` | string[] | pre-existing | Optional war-room tool allowlist. SDK tool names (`Bash`, `Write`) or `mcp:<name>`. |
| `meet_voice_id` | string | pre-existing | Pika voice id used when this agent joins a Google Meet. |
| `meet_bot_name` | string | pre-existing | Display name shown in the meeting. |
| `gradium_voice_id` | string | pre-existing | Gradium voice id for Telegram voice replies (and War Room TTS once swapped in). |

## Slice 1 additions (`agentic-os-spec-vision5-7-2026.md` § Slice 1)

All Slice-1 fields are **optional**. The migration script appends them with empty defaults. Empty defaults are safe — slices 3 / 4 / 5 / 7 ignore empties or render them as "unset".

| Field | Type | Slice | Description |
|---|---|---|---|
| `four_rs.results` | string[] | 1 | Measurable outcomes this agent is accountable for. Net new — no analog in `CLAUDE.md`. The other Four Rs (`role`, `responsibilities`, `requirements`) deliberately stay in `CLAUDE.md` as prose. |
| `owns.scheduled_tasks` | string[] | 1 | Task ids or slugs (rows in the `tasks` table) this agent owns. |
| `owns.triggered_tasks` | string[] | 1 | Triggered (webhook) task slugs — populated by Slice 2. |
| `owns.n8n_workflows` | string[] | 1 | n8n workflow ids or names this agent is on the hook for — used by Slice 4 routing. |
| `owns.watchers` | string[] | 1 | Names of `watchers.yaml` entries this agent owns. |
| `lob` | string | 1 | Line of business slug. Used by Slice 3 org chart. Empty until `lobs.yaml` exists. |
| `projects` | string[] | 1 | Project slugs / URLs this agent is assigned to (Slice 3). |
| `ideal` | bool | 1 | If `true`, the agent is mapped on the org chart but not yet built. Slice 3 "Ideal vs Active" tab uses this. |
| `platform` | string | 1 | One of `claude` / `openai` / `gemini` / `openrouter` / `subscription`. Slice 5 uses this for cost rollups (`subscription` → `$0` with badge). |
| `skills.primary` | string[] | 1 | Highlighted skills the agent leans on. **Hint, not allowlist** — agents still have access to every global skill. |
| `avatar` | string | 1 | Path or URL to the agent's avatar. Populated by Slice 7 persona generator. |

## Slice 10 additions (Wave 0 — `org-chart-v2`)

Two new top-level fields land Slice 10's "AI-as-head" org-chart model. Spec reference: the Obsidian note `LinkedIn — I Have 150 AI Employees (Org Chart Tour).md` (key idea: AI nodes can occupy ANY tier — heads, directors, ICs — not just leaves). The new `GET /api/org-chart-v2` endpoint reads both fields. Existing Slice 3 endpoints under `/api/org-chart/*` stay on the original shape and ignore these fields.

| Field | Type | Slice | Description |
|---|---|---|---|
| `type` | string | 10 | `"ai"` or `"human"`. Drives the OrgChartV2 card badge (color + icon). All current `agent.yaml` entries are `"ai"`; humans live in `humans.yaml` and pick up `"human"` from the same field there. |
| `reports_to` | string | 10 | Id of the parent node (another agent id, or a human id from `humans.yaml`). Drives the OrgChartV2 edges. Empty string (or omitted) means "root" — only Joe should be root in production. AI nodes may occupy any tier (head, director, IC), so `reports_to` may point at another AI (e.g. `meta`), not just at a human. |

Both fields are **optional** and default to empty (`""`). The migration script appends them with sensible defaults. Empty `type` is treated as `"ai"` by the org-chart-v2 reader for backwards compatibility; empty `reports_to` is treated as a root.

`humans.yaml` also gains a `type: "human"` field per entry plus an optional `reports_to` field (Joe is root → `reports_to: ""`; Ali reports to Joe → `reports_to: "joe"`).

## Explicitly NOT in YAML

These belong in `CLAUDE.md` as prose because they're persona instructions, not metadata:

- `role` — described in the opening paragraph of `CLAUDE.md`.
- `responsibilities` — bulleted under "What you handle" / "Your role".
- `requirements` — bulleted under "Hard rules" / style notes.
- `personality.tone` / `personality.pushback` / `personality.format` — captured in the "Style" section.
- `backstory` — Slice 7 generates this as a paragraph in `CLAUDE.md`, not as structured YAML.

This split keeps `agent.yaml` queryable (org chart, scorecards, n8n routing) while keeping the persona itself a markdown document the agent SDK can re-read every turn.

## Migrations

Run the Slice 1 migration to bring an existing agent up to the current schema:

```bash
tsx scripts/migrate-agent-schema.ts                # default <repo>/agents
tsx scripts/migrate-agent-schema.ts <agents-dir>   # custom location
tsx scripts/migrate-agent-schema.ts --dry-run      # report only
```

The script is idempotent — it only appends keys that are missing. Existing key/value pairs and comments are left bit-identical because the script edits the raw text rather than round-tripping through `yaml.dump`.

Run the Slice 10 Wave 0 migration to add `type` + `reports_to` to every agent and to humans.yaml:

```bash
tsx scripts/migrate-org-v2.ts                      # default <repo>
tsx scripts/migrate-org-v2.ts --dry-run            # report only
tsx scripts/migrate-org-v2.ts --root <path>        # custom repo root
```

Same idempotency contract as Slice 1: re-running adds nothing if the keys already exist, and existing key/value pairs and comments stay bit-identical.
