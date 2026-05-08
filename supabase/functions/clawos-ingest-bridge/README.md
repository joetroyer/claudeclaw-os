# clawos-ingest-bridge

**Source table:** `analysis.signals_l1` (observation-only L1 ingest)
**clawos watcher slug:** `trading-monitor-ingest`
**Webhook URL:** `https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor-ingest`
**Secret env:** `TRADING_MONITOR_INGEST_SECRET` (must match clawos `.env`)
**Default mode on clawos side:** `test` — flip to `run` once smoked.

## What it does

Subscribes to a Supabase Database Webhook on `analysis.signals_l1` (INSERT
only — L1 rows are immutable). For each new ingest signal it:

1. Optionally filters by provider (set `PROVIDER_ALLOWLIST` env var to
   narrow; default is "forward all").
2. Maps the row to the clawos payload shape (provider, side, entry,
   entry_range, sl, tp[], is_split_message, is_buy_now, parser_warnings).
3. HMAC-SHA256 signs the body using `TRADING_MONITOR_INGEST_SECRET`.
4. POSTs to the clawos webhook.

The clawos watcher queues an observation-only mission task — `priority=low`,
log to `hive_mind`, **never ping Telegram** (different prompt template than
the live ceddi-bridge path).

## Currently observed providers

Per goldbot migration 066, `analysis.signals_l1.provider` accepts:

| Provider | Source | Status |
|---|---|---|
| `ceddi` | Ceddi Trades Production | (mostly hits live `public.signals`, but L1 may also receive shadow rows) |
| `gold_scalping` | Gold Scalping & Zones (-1003748290932) | ingest_only (Ship C 2026-05-04) |
| `goldsignals_swing` | GoldSignals.io VIP Swing (-1001182914334) | ingest_only |
| `goldsignals_intraday` | GoldSignals.io VIP Intraday (-1001260896861) | ingest_only |

To add another provider:
1. Add a goldbot migration widening the CHECK constraint (see migration 066).
2. Insert a row in `public.signal_channels` with `kind='ingest_only'` and the new provider's `kind` value.
3. The bridge needs **zero changes** unless you want per-provider behaviour.

## Setup

```bash
# 1. Pull the secret from clawos .env
SECRET=$(grep '^TRADING_MONITOR_INGEST_SECRET=' /Volumes/4TB-990/dev/claude-clawos/.env | cut -d= -f2-)

# 2. Deploy
cd /Volumes/4TB-990/dev/claude-clawos
supabase functions deploy clawos-ingest-bridge
supabase secrets set TRADING_MONITOR_INGEST_SECRET="$SECRET"

# (optional) Narrow to one provider for first smoke:
# supabase secrets set PROVIDER_ALLOWLIST="goldsignals_swing"

# 3. Wire the Database Webhook (Supabase dashboard)
#    Database → Webhooks → New
#      Schema:   analysis           ← change from default 'public'
#      Table:    signals_l1
#      Events:   ☑ Insert            (skip Update + Delete)
#      Type:     Supabase Edge Functions
#      Function: clawos-ingest-bridge
```

## Test

### Direct curl

```bash
FN_URL=$(supabase functions list | awk '/clawos-ingest-bridge/ {print $NF}')
curl -X POST "$FN_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "INSERT",
    "table": "signals_l1",
    "schema": "analysis",
    "record": {
      "signal_id": "00000000-0000-0000-0000-000000000099",
      "provider": "goldsignals_swing",
      "source_channel_id": "-1001182914334",
      "source_msg_id": 12345,
      "posted_at": "2026-05-08T14:00:00Z",
      "direction": "BUY",
      "entry_low": 2348,
      "entry_high": 2352,
      "entry_mid": 2350,
      "sl": 2345,
      "tp_levels": [2360, 2365, 2370],
      "is_split_message": false,
      "is_buy_now": false,
      "parser_warnings": [],
      "raw_text": "BUY XAUUSD 2348-2352 SL 2345 TP 2360 2365 2370"
    }
  }'
```

Expect `{"ok":true,"upstream_status":200,"forwarded_signal_id":"…","provider":"goldsignals_swing"}`.

Then check clawos:

```bash
sqlite3 /Volumes/4TB-990/dev/claude-clawos/store/claudeclaw.db \
  "SELECT id, assigned_agent, substr(title, 1, 80) FROM mission_tasks
   WHERE assigned_agent='trading-monitor' ORDER BY created_at DESC LIMIT 3;"
```

### Real DB insert

In Supabase SQL editor:

```sql
INSERT INTO analysis.signals_l1
  (provider, source_channel_id, source_msg_id, posted_at, direction,
   entry_low, entry_high, entry_mid, tp_levels, sl, raw_text)
VALUES
  ('goldsignals_swing', '-1001182914334', 99999, now(), 'BUY',
   2348, 2352, 2350, '{2360,2365,2370}', 2345,
   'TEST INSERT BUY XAUUSD 2348-2352 SL 2345');
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `500 TRADING_MONITOR_INGEST_SECRET not configured` | Secret missing in Supabase | `supabase secrets set TRADING_MONITOR_INGEST_SECRET=…` |
| `upstream_status: 401` | Secret mismatch or bot not restarted | Verify both `.env` and Supabase secret match; restart bot if env var was just added |
| `skipped: provider=… not in allowlist` | `PROVIDER_ALLOWLIST` set and excludes this provider | Either remove the env var (forward all) or include the provider |
| `skipped: <type> ignored` | Function is INSERT-only by design | Change Database Webhook to only fire on Insert |
| Database Webhook never fires for `analysis.signals_l1` | The webhook UI defaults to `public` schema | Re-create the webhook with Schema: `analysis` selected |

## Going live

1. Deploy + smoke per above.
2. In `https://clawos.joetroyer.com/triggered`, click Edit on `trading-monitor-ingest`, change Mode `test` → `run`. Save.
3. Watch the L1 ingest stream flow through (you'll get a steady drip during US/London sessions when GS / GoldSignals.io are active).
