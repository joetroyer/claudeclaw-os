# Slice 2 — Webhook Signing Reference

External callers sign requests with HMAC-SHA256 over the **raw request body**, hex-encoded. The signature goes in the `X-Claudeclaw-Signature` header.

## Header

```
X-Claudeclaw-Signature: sha256=<lowercase-hex>
```

The `sha256=` prefix is GitHub-style and is the recommended format. A bare hex string is also accepted for callers that can't customize the prefix. `X-Hub-Signature-256` is accepted as a fallback header name (compat with GitHub-style senders).

## Algorithm

```
expected = HMAC_SHA256(key=secret, message=raw_body) -> hex digest
```

The server compares against the provided digest with `crypto.timingSafeEqual` — constant-time compare so signature mismatches don't leak timing information.

## Modes

| Mode      | HMAC required | Behavior                                                    |
|-----------|---------------|-------------------------------------------------------------|
| `run`     | yes           | Mismatch → 401; otherwise actions fire normally             |
| `test`    | yes           | Mismatch → 401; actions fire, payload tagged `mode='test'` |
| `preview` | no            | Payload is captured for UI inspection; no actions fire     |

In all modes, the payload is persisted to `webhook_payloads` (even on rejection) so an operator can debug from the UI without grepping logs.

## Examples

### Node.js

```js
import crypto from 'crypto';

const SECRET = process.env.TRADING_MONITOR_SECRET;
const url = 'https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor';
const body = JSON.stringify({
  signal: 'buy',
  instrument: 'XAUUSD',
  entry: 2350.0,
});

const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-claudeclaw-signature': 'sha256=' + sig,
  },
  body,
});
```

### bash + openssl

```bash
SECRET="${TRADING_MONITOR_SECRET}"
URL="https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor"
BODY='{"signal":"buy","instrument":"XAUUSD","entry":2350.0}'

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST "$URL" \
  -H "content-type: application/json" \
  -H "x-claudeclaw-signature: sha256=$SIG" \
  --data-raw "$BODY"
```

### Python

```python
import hmac, hashlib, json, urllib.request

SECRET = b"<your-secret>"
url = "https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor"
body = json.dumps({"signal": "buy", "instrument": "XAUUSD"}).encode("utf-8")

sig = hmac.new(SECRET, body, hashlib.sha256).hexdigest()

req = urllib.request.Request(
    url,
    data=body,
    headers={
        "content-type": "application/json",
        "x-claudeclaw-signature": f"sha256={sig}",
    },
    method="POST",
)
urllib.request.urlopen(req).read()
```

### n8n

In n8n, add a "Crypto" node before the HTTP Request node:

1. **Crypto** node:
   - Action: `HMAC`
   - Type: `SHA256`
   - Value: the request body string (e.g. `={{ JSON.stringify($json) }}`)
   - Secret: `{{ $env.TRADING_MONITOR_SECRET }}`
   - Encoding: `hex`
2. **HTTP Request** node:
   - Method: POST
   - URL: `https://clawos.joetroyer.com/api/watchers/webhook/<slug>`
   - Headers: `X-Claudeclaw-Signature: sha256={{ $node["Crypto"].json["data"] }}`
   - Body: same body string passed to the Crypto node

## Common failure modes

| Symptom                                               | Cause                                                                |
|-------------------------------------------------------|----------------------------------------------------------------------|
| 401 `reason: signature mismatch`                      | Different body bytes than what was signed (e.g. extra whitespace)    |
| 401 `reason: missing signature`                       | Header not set or wrong header name                                  |
| 401 `reason: secret not configured`                   | `secret_env` in watchers.yaml not set in the dashboard's environment |
| 200 with `mode: preview` and no actions               | Watcher's `mode` is `preview`. Flip to `run` in watchers.yaml        |
| 404 `webhook not found`                               | Slug doesn't match any `webhook` watcher                             |
| 400 `invalid slug`                                    | Slug contains characters outside `[a-z0-9-]` or starts with `-`      |

## Slug rules

Slug must match `^[a-z0-9][a-z0-9-]{0,63}$` (case-insensitive in the regex but the URL is canonicalized lowercase). Examples: `trading-monitor`, `n8n-error`, `supabase-cron`.
