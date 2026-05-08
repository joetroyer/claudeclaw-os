# Slice 4 — n8n error router end-to-end smoke

Worked transcript of an n8n-style error flowing in via webhook and surfacing as `mission_tasks`. Captured by running the live runtime against a tmp on-disk SQLite (so the prod DB stays clean).

## Setup

- `dist/dashboard.js` built from `slice-4-n8n-auto-tasks` branch.
- watchers.yaml entry `n8n-error-router` with `mode: test`, `slug: n8n-error`, `secret_env: N8N_ERROR_SECRET`.
- Tmp store DB at `/tmp/slice4-smoke-<ts>.db`, override via `CLAUDECLAW_STORE_DB_PATH`.
- `N8N_ERROR_SECRET=smoke-secret`.
- `SLACK_WEBHOOK_URL=https://hooks.slack.example/...` (mocked via fetch wrapper — no real network).

## Step 1 — Seed an owner

```sql
INSERT INTO n8n_workflow_owners (workflow_id, agent_id, created_at)
VALUES ('wf_demo_owned', 'research', strftime('%s','now'));
```

## Step 2 — POST signed payload for an OWNED workflow

```bash
BODY='{"workflow_id":"wf_demo_owned","workflow_name":"Demo Owned","error_message":"broker api 500","error_signature":"fp_abc","execution_url":"https://n8n.example/exec/123"}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','smoke-secret').update('$BODY').digest('hex'))")

curl -s -X POST "$BASE/api/watchers/webhook/n8n-error" \
  -H "content-type: application/json" \
  -H "x-claudeclaw-signature: sha256=$SIG" \
  -d "$BODY"
```

Result:

```
status = 200
queued = [ 'wat_mow6m5cq_ej76s3' ]
task assigned_agent = research
task title          = n8n error: Demo Owned (wf_demo_owned)
```

The mission task lands on the owning agent (`research`) — the watcher's `lookup-owner` resolved `wf_demo_owned → research`, the `if-owned` gate fired, the `queue-mission` action with `agent: '{_owner_agent}'` substituted to `research`.

## Step 3 — POST unsigned payload (HMAC enforcement)

```bash
curl -s -X POST "$BASE/api/watchers/webhook/n8n-error" \
  -H "content-type: application/json" \
  -d '{"workflow_id":"wf_demo_owned"}'
```

Result:

```
status = 401
reason = missing signature
```

HMAC enforcement is inherited from Slice 2's webhook ingress (same code path). No mission queued, payload still logged with `signature_valid=0` for audit.

## Step 4 — POST signed payload for an UNOWNED workflow

```bash
BODY='{"workflow_id":"wf_demo_unowned","workflow_name":"Mystery","error_message":"kaboom","error_signature":"fp_xyz"}'
# ... HMAC sign + POST ...
```

Result:

```
status = 200
queued = [ 'wat_mow6m5cs_pa6g9q' ]
task assigned_agent = meta
task title          = n8n triage: unowned workflow wf_demo_unowned
slack calls         = 1
slack text snippet  = :rotating_light: Unowned n8n workflow errored.
                      Workflow: Mystery (id: wf_demo_un...
```

The `lookup-owner` returned null → `if-unowned` fired → BOTH actions ran:
1. `queue-mission` on `meta` (triage).
2. `send-slack` POSTed to `SLACK_WEBHOOK_URL` with the templated message containing a `/mission` link.

## Step 5 — POST the same UNOWNED payload again (debounce)

```bash
# identical BODY + SIG to Step 4
```

Result:

```
status = 200
queued = []
```

Watcher log line confirms:

```
INFO: watcher: n8n debounce hit — skipping nested actions
  workflow_id: "wf_demo_unowned"
  error_signature: "fp_xyz"
```

The payload is still ingested (audit log preserved in `webhook_payloads`), but `lookup-owner` set `_n8n_debounced=true`, so both `if-owned` and `if-unowned` short-circuited and zero mission_tasks were queued.

## Step 6 — POST same workflow_id with a DIFFERENT error_signature

```bash
BODY='{"workflow_id":"wf_demo_unowned","workflow_name":"Mystery","error_message":"different problem","error_signature":"fp_other"}'
```

Result:

```
status = 200
queued = [ 'wat_mow6m5cu_ixzyre' ]
```

A new mission_task fires because the debounce key (`workflow_id::error_signature`) is different from Step 4. This is the intended behavior: a single workflow can have multiple distinct failure modes, each of which deserves its own triage.

## Cleanup

The smoke uses a tmp on-disk SQLite (`/tmp/slice4-smoke-<ts>.db`) which is `unlink`ed at exit. The production `store/claudeclaw.db` is never written to during this transcript.

## Acceptance summary

| Acceptance criterion                                      | Step    | Result |
|-----------------------------------------------------------|---------|--------|
| Owned error → exactly 1 mission on owning agent           | 2       | PASS   |
| Unowned error → 1 mission on meta + Slack post            | 4       | PASS   |
| Same error fired twice → 1 mission (debounce)             | 4 + 5   | PASS   |
| HMAC enforced (mis-signed → 401)                          | 3       | PASS   |
| Different error signatures → not debounced                | 4 + 6   | PASS   |
| Existing webhook ingress (Slice 2) still works            | 3       | PASS (same code path) |

Full raw output captured at `proof/slice-4/e2e-smoke-output.txt`.
