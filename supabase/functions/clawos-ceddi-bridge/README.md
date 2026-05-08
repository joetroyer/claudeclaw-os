# clawos-ceddi-bridge

**Source table:** `public.signals` (live broker dispatch pipeline)
**clawos watcher slug:** `trading-monitor`
**Webhook URL:** `https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor`
**Secret env:** `TRADING_MONITOR_SECRET` (must match clawos `.env`)
**Default mode on clawos side:** `test` — flip to `run` once smoked.

## What it does

Subscribes to a Supabase Database Webhook on `public.signals` (INSERT +
UPDATE). For each event it:

1. Validates the source channel kind (must be `ceddi` or `unknown`; other
   kinds are routed via different bridges).
2. Maps the row to the clawos payload shape (provider, instrument, side,
   entry, sl, tp, status, raw).
3. HMAC-SHA256 signs the body using `TRADING_MONITOR_SECRET`.
4. POSTs to the clawos webhook with `X-Claudeclaw-Signature: sha256=<hex>`.

The clawos watcher then queues a mission task on the `trading-monitor`
agent. The agent parses, classifies, logs to `hive_mind`, and pings on
high-priority. **No orders are sent. No broker integration.**

## Setup

```bash
# 1. Pull the secret from clawos .env
SECRET=$(grep '^TRADING_MONITOR_SECRET=' /Volumes/4TB-990/dev/claude-clawos/.env | cut -d= -f2-)

# 2. Deploy
cd /Volumes/4TB-990/dev/claude-clawos
supabase login                                    # first time only
supabase link --project-ref jzvgwxcckhwumdrtoebf  # the goldbot project
supabase functions deploy clawos-ceddi-bridge

# 3. Set the secret on the function
supabase secrets set TRADING_MONITOR_SECRET="$SECRET"

# 4. Wire the Database Webhook (Supabase dashboard)
#    Database → Webhooks → New
#      Table:    public.signals
#      Events:   ☑ Insert  ☑ Update     (skip Delete)
#      Type:     Supabase Edge Functions
#      Function: clawos-ceddi-bridge
```

## Test

### Direct curl (synthetic webhook event)

```bash
FN_URL=$(supabase functions list | awk '/clawos-ceddi-bridge/ {print $NF}')
curl -X POST "$FN_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "INSERT",
    "table": "signals",
    "schema": "public",
    "record": {
      "signal_id": "00000000-0000-0000-0000-000000000001",
      "signal_type": "full",
      "status": "filling",
      "direction": "buy",
      "entry_price": 2350,
      "signal_sl_price": 2345,
      "tp_levels": [2360, 2370],
      "source_channel_kind": "ceddi"
    }
  }'
```

Expect `{"ok":true,"upstream_status":200,...}`. Then on clawos:

```bash
sqlite3 /Volumes/4TB-990/dev/claude-clawos/store/claudeclaw.db \
  "SELECT id, assigned_agent, substr(title, 1, 80) FROM mission_tasks
   WHERE assigned_agent='trading-monitor' ORDER BY created_at DESC LIMIT 3;"
```

### Real DB insert (live path)

In Supabase SQL editor:

```sql
INSERT INTO public.signals
  (signal_type, status, direction, entry_price, signal_sl_price, tp_levels, source_channel_kind)
VALUES
  ('full', 'filling', 'buy', 2350, 2345, '{2360,2370}', 'ceddi');
```

The Database Webhook fires automatically.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `500 TRADING_MONITOR_SECRET not configured` | Secret missing in Supabase | `supabase secrets set TRADING_MONITOR_SECRET=…` |
| `upstream_status: 401, reason: signature mismatch` | Secrets diverged or body re-encoded | Both sides must match. Re-set both. |
| `upstream_status: 401, reason: secret not configured` | clawos `.env` missing or bot not restarted after adding | `grep TRADING_MONITOR_SECRET /Volumes/4TB-990/dev/claude-clawos/.env` then `launchctl kickstart -k gui/$(id -u)/com.claudeclaw.main` |
| Bridge skipped with `source_channel_kind=… not handled` | A non-ceddi channel wrote to `public.signals` (shouldn't happen today) | Investigate goldbot dispatcher — `public.signals` should be ceddi-only |
| Mission task created but on wrong agent | Watcher slug mismatch | Slug must be exactly `trading-monitor`; check `watchers.yaml` |

## Going live

1. Deploy + smoke per above.
2. In `https://clawos.joetroyer.com/triggered`, click Edit on `trading-monitor-trigger`, change Mode `test` → `run`. Save.
3. Watch real ceddi signals flow through.
