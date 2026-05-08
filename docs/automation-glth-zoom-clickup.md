# GLTH Zoom Recording → ClickUp Tasks (automation setup)

End-to-end pipeline that turns each GLTH Sales & Marketing Zoom recording
into a list of ClickUp tasks under the GLTH list.

```
Zoom Cloud  →  Slack #integration-alerts  →  n8n  →  clawos webhook  →  ops agent  →  ClickUp
```

## Architecture

| Stage | Where | What |
|-------|-------|------|
| 1. Recording finishes | Zoom Cloud | Existing Slack/Zoom integration posts a "Zoom Recording Completed" message into `#integration-alerts`. |
| 2. Detect + parse | n8n (`n8n.joetroyer.com`) | Slack Trigger fires on new message, filters to GLTH Sales & Marketing only, parses meeting name / duration / recording URL out of the message text. |
| 3. Sign + forward | n8n HTTP Request node | HMAC-SHA256 signs the JSON body with `GLTH_ZOOM_SECRET`, POSTs to `https://clawos.joetroyer.com/api/hooks/glth-zoom-recording`. |
| 4. Watcher accepts | clawos (this repo) | `watchers.yaml` slug `glth-zoom-recording` verifies the HMAC, queues a `mission_task` for the `ops` agent. |
| 5. Recap | ops agent | Pulls transcript, finds the meeting Google Doc via `gws drive search`, synthesises action items, creates ClickUp tasks via the `clickup` skill, replies on Telegram. |

## Why ops, not meta?

The work is operational follow-up: read meeting → extract action items →
push to a task tracker. That falls under the ops agent's existing remit
(task management, admin, follow-ups). Meta is the coordinator and
shouldn't end up holding an integration's day-to-day execution.

## Setup checklist

### 1. Generate the shared secret

```bash
openssl rand -hex 32
```

Add it to **clawos** `.env` (NOT `.env.example`):

```
GLTH_ZOOM_SECRET=<hex>
```

### 2. Add ClickUp + (optional) Zoom creds

In the same `.env`:

```
CLICKUP_API_TOKEN=<from https://app.clickup.com/settings/apps>

# Optional: Server-to-Server OAuth for transcript pulls. If absent, the
# agent falls back to the public share-link path.
ZOOM_ACCOUNT_ID=
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
```

### 3. Restart the main bot

The watcher loads its env on bot startup:

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.main
```

Confirm the slug is registered:

```bash
tail -n 200 /tmp/claudeclaw-main.log | grep glth-zoom-recording
# should show: watcher: webhook registered (HTTP-driven) ... slug=glth-zoom-recording
```

### 4. Import the n8n workflow

1. Open `https://n8n.joetroyer.com`.
2. Settings → **Import from File** → select
   `automation/n8n-glth-zoom-to-clickup.json` from this repo.
3. Open the imported workflow. Three things to wire:
   - **Slack: #integration-alerts** node — replace
     `REPLACE_WITH_INTEGRATION_ALERTS_CHANNEL_ID` with the actual channel
     ID (the `C…` string from Slack's "Copy link to channel"). Bind to
     your existing `Slack OAuth (joetroyer.com)` credential.
   - **Sign HMAC** node — uses `$env.GLTH_ZOOM_SECRET`. Add the env var:
     n8n → Settings → Variables → `GLTH_ZOOM_SECRET = <same hex from .env>`.
     If self-hosted via Docker, also set it in the docker-compose env
     block and restart the n8n container.
   - **POST clawos** node — already points at
     `https://clawos.joetroyer.com/api/hooks/glth-zoom-recording`. Leave
     as-is unless your tunnel URL changed.
4. Activate the workflow (toggle top-right).

### 5. End-to-end smoke test

Drop a fake message into `#integration-alerts` (matching the exact
format Zoom uses):

```
Zoom Recording Completed:
Meeting: GLTH Sales & Marketing Meeting
Duration: 1 minutes
Recording Link: https://example.com/test
```

Then check:

```bash
# n8n → executions tab should show success
# clawos → mission_task should be queued for ops:
sqlite3 store/claudeclaw.db \
  "SELECT id, assigned_agent, title, source, source_id FROM mission_tasks WHERE source_id='glth-zoom-recording' ORDER BY created_at DESC LIMIT 3"
```

Cancel the test task once you confirm the row exists:

```bash
node dist/mission-cli.js cancel <task-id>
```

## Watcher entry

The watcher is defined in `watchers.yaml`:

```yaml
- name: glth-zoom-recording
  type: webhook
  slug: glth-zoom-recording
  secret_env: GLTH_ZOOM_SECRET
  mode: run
  actions:
    - queue-mission:
        agent: ops
        ...
```

Mode `run` means valid POSTs immediately fire actions. To debug payloads
without firing the agent, temporarily flip to `mode: preview` and use
`/api/watchers/webhook/glth-zoom-recording/payloads?token=...` to inspect
incoming requests.

## Open questions

- **Zoom transcript fetcher.** The agent prompt enumerates three paths
  (skill / OAuth / share-link scrape). None are implemented in the
  repo today — the agent figures it out per-call. If this becomes a
  hot path, lift the working approach into `~/.claude/skills/zoom/`.
- **Google Doc resolution.** The `gws drive search` heuristic
  (title-match + recently-modified) is good enough for one recurring
  meeting; if Joe adds more recurring meetings, extend the prompt to
  pass an explicit doc URL or ID per meeting.
- **ClickUp list.** Currently hard-pinned to list `901800809572`. If
  another GLTH list is preferred, edit the watcher prompt and restart
  the main bot.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 from `/api/hooks/glth-zoom-recording` | `GLTH_ZOOM_SECRET` mismatch between n8n and clawos `.env` | Re-paste the hex into both, restart main bot + n8n. |
| 503 with `mutations disabled (incident kill switch)` | `DASHBOARD_MUTATIONS_ENABLED` flag is off | Flip the kill switch back on from the dashboard. |
| Watcher fires but no task appears in mission_tasks | Wrong agent slug typo in `watchers.yaml` | Confirm `agent: ops` (plural lowercase, no spaces). |
| ops agent stalls at "no transcript" | None of the 3 transcript paths worked | Inspect the failed mission's reply; supply Zoom OAuth creds in `.env` if you want a deterministic path. |
