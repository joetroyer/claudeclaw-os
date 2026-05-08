# clawos-trading-monitor — Supabase Edge Function

Bridges new rows in your `signals` table to the ClaudeClaw `trading-monitor` webhook with HMAC-SHA256 signing. The trading-monitor agent then parses, classifies, logs to hive_mind, and (if priority=high) pings you on Telegram.

**Read-only.** No orders sent. No broker integration. The agent's CLAUDE.md is explicit about this.

## Setup (5 steps)

### 1. Pull the secret value from clawos

```bash
grep '^TRADING_MONITOR_SECRET=' /Volumes/4TB-990/dev/claude-clawos/.env | cut -d= -f2-
```

Copy that hex string.

### 2. Deploy the function to your Supabase project

From this repo root:

```bash
cd /Volumes/4TB-990/dev/claude-clawos
supabase login    # if not already
supabase link --project-ref <YOUR_PROJECT_REF>   # only first time
supabase functions deploy clawos-trading-monitor
```

### 3. Set the secret

```bash
supabase secrets set TRADING_MONITOR_SECRET=<the-hex-string-from-step-1>
```

(You can also set `CLAWOS_WEBHOOK_URL` if you want to point at a non-prod URL during testing — defaults to `https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor`.)

### 4. Wire the Database Webhook

In the Supabase dashboard:

- **Database → Webhooks → Create a new hook**
- Name: `clawos-trading-monitor-on-signal`
- Table: `signals`
- Events: ☑ `Insert` (and optionally `Update` if you also want fill/exit events)
- Type: **Supabase Edge Functions**
- Edge Function: `clawos-trading-monitor`
- HTTP Headers: leave defaults
- Save

### 5. Test

#### A. Direct curl (synthetic body simulating a webhook event)

```bash
FN_URL=$(supabase functions list | awk '/clawos-trading-monitor/ {print $NF}')
curl -X POST "$FN_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "INSERT",
    "table": "signals",
    "record": {
      "signal_id": "00000000-0000-0000-0000-000000000001",
      "signal_type": "full",
      "status": "filling",
      "direction": "buy",
      "entry_price": 2350,
      "signal_sl_price": 2345,
      "tp_levels": [2360, 2370]
    }
  }'
```

Expect: `{"ok":true,"upstream_status":200,...}`. On the clawos side, watch:

```bash
sqlite3 /Volumes/4TB-990/dev/claude-clawos/store/claudeclaw.db \
  "SELECT id, assigned_agent, substr(title, 1, 80) FROM mission_tasks
   WHERE assigned_agent='trading-monitor' ORDER BY created_at DESC LIMIT 3;"
```

#### B. End-to-end via real DB insert (in Supabase SQL editor)

```sql
INSERT INTO signals (signal_type, status, direction, entry_price, signal_sl_price, tp_levels)
VALUES ('full', 'filling', 'buy', 2350, 2345, '{2360,2370}');
```

The Database Webhook should fire automatically. Same DB query above to confirm the mission_task landed.

## Going live

The Slice 2 watcher in clawos `watchers.yaml` ships in `mode: test`. Once you've seen a couple of synthetic + real signal events flow through cleanly, flip the mode in the dashboard:

- Open `https://clawos.joetroyer.com/triggered`
- Click **Edit** on `trading-monitor-trigger`
- Change Mode from **test** to **run**
- Save

## Failure modes + debugging

| Symptom | Cause | Fix |
|---|---|---|
| Function returns `500 TRADING_MONITOR_SECRET not configured` | Secret missing in Supabase | `supabase secrets set TRADING_MONITOR_SECRET=…` |
| `upstream_status: 401, reason: missing signature` | Function deployed but secret value mismatched | Both sides must have the SAME secret |
| `upstream_status: 401, reason: signature mismatch` | Secret values diverged or body re-serialized between sign and send | Check the function isn't double-encoding; HMAC is over the raw bytes that go in the request body |
| `upstream_status: 401, reason: secret not configured` | clawos `.env` missing `TRADING_MONITOR_SECRET` or bot wasn't restarted after adding | `grep TRADING_MONITOR_SECRET /Volumes/4TB-990/dev/claude-clawos/.env` then `launchctl kickstart -k gui/$(id -u)/com.claudeclaw.main` |
| Function works in curl but DB webhook never fires | Database Webhook isn't enabled or wrong table | Check the webhook config in Supabase dashboard |
| Mission task created on `meta` instead of `trading-monitor` | The watcher slug doesn't match `trading-monitor` | Check `watchers.yaml` for slug; the URL path must be `/api/watchers/webhook/trading-monitor` |

## Tuning what fires

The default function forwards every INSERT and UPDATE on the `signals` table. To narrow:

- Change the Database Webhook's event filter to only `INSERT`.
- Or modify `index.ts` to skip events whose `record.status` isn't a fresh entry (e.g. only forward when status in `('filling', 'active')`).

## Files

- `index.ts` — the function (Deno + Supabase Edge runtime).
- `README.md` — this file.
