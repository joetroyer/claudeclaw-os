name: {{DISPLAY_NAME}}
description: {{DESCRIPTION}}

telegram_bot_token_env: {{TOKEN_ENV}}

model: claude-sonnet-4-6

# ────────────────────────────────────────────────────────────────────
# Slice 1 schema (populated by Slice 7 persona generator).
# Persona prose (role / responsibilities / personality / backstory)
# lives in CLAUDE.md, not here.
# ────────────────────────────────────────────────────────────────────

# Slice 1: measurable outcomes for the Four Rs.
four_rs:
  results: {{RESULTS_YAML}}

# Slice 1: ownership pointers, populated by Slices 3/4 routing.
owns:
  scheduled_tasks: []
  triggered_tasks: []
  n8n_workflows: []
  watchers: []

# Slice 1: line of business (used by Slice 3 org chart).
lob: "{{LOB}}"

# Slice 1: projects this agent is assigned to (used by Slice 3).
projects: {{PROJECTS_YAML}}

# Slice 1: ideal=true means mapped on org chart but not yet built.
ideal: false

# Slice 1: platform routing. claude | openai | gemini | openrouter | subscription.
platform: "claude"

# Slice 1: primary skills this agent leans on (hint, not allowlist).
skills:
  primary: {{SKILLS_YAML}}

# Slice 1: avatar path or URL.
avatar: "{{AVATAR_REL_PATH}}"
