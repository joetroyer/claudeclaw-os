# Slice 4 — n8n payload schema (DRAFT)

**Status:** DRAFT — surfaced for operator approval per slice instructions ("Stop and ask before deciding the n8n payload schema").

## Required fields

| Field          | Type     | Notes                                                                                  |
|----------------|----------|----------------------------------------------------------------------------------------|
| `workflow_id`  | string   | Stable identifier for the n8n workflow. Used for owner lookup AND debounce.            |
| `error_message`| string   | The error text. Used as fallback for the debounce signature when `error_signature` is missing. |

## Optional fields

| Field            | Type    | Notes                                                                              |
|------------------|---------|------------------------------------------------------------------------------------|
| `workflow_name`  | string  | Human display name. Surfaced in the mission_task title and Slack post.             |
| `error_signature`| string  | Stable fingerprint of the error class. Preferred debounce key. Falls back to a hash of `error_message` (first 500 chars, FNV-1a) if absent. |
| `execution_id`   | string  | n8n execution UUID. Logged for traceability.                                       |
| `execution_url`  | string  | Direct link to the run in the n8n UI. Surfaced in the mission_task body and Slack post. |
| `severity`       | enum    | `error` \| `warning` \| `info`. Reserved for future routing; ignored today.        |

## Field-name configurability

The watcher YAML lets operators rename the ingress fields per workflow:

```yaml
- lookup-owner:
    workflow_field:  workflow_id        # default — payload.workflow_id
    signature_field: error_signature    # default — payload.error_signature
    debounce_sec:    60
```

If a particular n8n integration emits `wf_id` or `id` instead of `workflow_id`, point at it via `workflow_field: wf_id`.

## Example payload (representative)

```json
{
  "workflow_id":     "wf_lab_etl_42",
  "workflow_name":   "Goldbot Lab — daily ETL",
  "error_message":   "Connection refused on broker-api:443",
  "error_signature": "ENOTFOUND-broker-api",
  "execution_id":    "exec_2c4e8e8e",
  "execution_url":   "https://n8n.example.com/workflow/wf_lab_etl_42/executions/exec_2c4e8e8e"
}
```

## n8n-side wiring sketch

n8n's "Error Trigger" node fires when any workflow fails. Wire it into a single global error router workflow that POSTs the structured payload above to `https://clawos.joetroyer.com/api/watchers/webhook/n8n-error` with header:

```
X-Claudeclaw-Signature: sha256=<hmac of raw body using N8N_ERROR_SECRET>
```

n8n's HTTP Request node supports HMAC headers via a Function node:

```js
const crypto = require('crypto');
const secret = $env.CLAUDECLAW_N8N_SECRET;          // mirror of N8N_ERROR_SECRET
const body = JSON.stringify($json);
const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
return [{ json: { body, sig: 'sha256=' + sig } }];
```

## Open questions for operator (for next-pass refinement, not blocking the slice)

1. Confirm the field names. If your existing n8n workflows already POST a different shape (e.g. `wf` instead of `workflow_id`), tell me and I'll adjust either the schema OR the `workflow_field` config. The current default is the most ergonomic for new wiring.
2. Confirm `severity` is something we want for v2. If yes, we'd add an `if-severity` action arm.
3. Confirm Slack channel routing. Currently a single SLACK_WEBHOOK_URL → wherever that webhook is wired. If you want #ops vs #alerts split by severity, we add `webhook_url_env` per action.
