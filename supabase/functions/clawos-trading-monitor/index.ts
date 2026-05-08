// Supabase Edge Function — clawos-trading-monitor
//
// Bridges new rows in the `signals` table to the ClaudeClaw trading-monitor
// webhook. Triggered by a Supabase Database Webhook on INSERT/UPDATE; computes
// HMAC-SHA256 over the body using TRADING_MONITOR_SECRET, then POSTs to:
//
//   https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor
//
// Env vars expected on the Supabase function:
//   TRADING_MONITOR_SECRET  — same value as in claude-clawos .env (HMAC key)
//   CLAWOS_WEBHOOK_URL      — optional override; defaults to the prod URL above
//
// Deploy:
//   supabase functions deploy clawos-trading-monitor
//   supabase secrets set TRADING_MONITOR_SECRET=<value-from-clawos-.env>
//
// Wire (Supabase dashboard → Database → Webhooks):
//   - Table:  signals
//   - Events: INSERT (and optionally UPDATE)
//   - Type:   Supabase Edge Functions
//   - Function: clawos-trading-monitor
//
// Test:
//   curl -X POST '<function-url>' \
//     -H 'Content-Type: application/json' \
//     -d '{"type":"INSERT","table":"signals","record":{"signal_id":"00000000-0000-0000-0000-000000000001","status":"filling","direction":"buy","entry_price":2350,"signal_sl_price":2345,"tp_levels":[2360,2370],"signal_type":"full"}}'
//
// or insert a row in the dashboard SQL editor:
//   INSERT INTO signals (signal_type, status, direction, entry_price, signal_sl_price, tp_levels)
//   VALUES ('full','filling','buy',2350,2345,'{2360,2370}');

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

interface SignalRecord {
  signal_id?: string;
  signal_type?: string;
  status?: string;
  direction?: string;
  entry_price?: number | string | null;
  signal_sl_price?: number | string | null;
  tp_levels?: Array<number | string> | null;
  trigger_message_id?: number | null;
  created_at?: string;
}

interface SupabaseDbWebhookEvent {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema?: string;
  record?: SignalRecord;
  old_record?: SignalRecord;
}

const CLAWOS_WEBHOOK_URL =
  Deno.env.get('CLAWOS_WEBHOOK_URL') ||
  'https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor';

const SECRET = Deno.env.get('TRADING_MONITOR_SECRET') || '';

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!SECRET) {
    return new Response(JSON.stringify({ error: 'TRADING_MONITOR_SECRET not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  let event: SupabaseDbWebhookEvent;
  try {
    event = (await req.json()) as SupabaseDbWebhookEvent;
  } catch (err) {
    return new Response(JSON.stringify({ error: 'invalid json', detail: String(err) }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Only forward live new-signal events. Skip DELETEs and ignore status
  // transitions we don't care about (e.g. updates after fill).
  const record = event.record;
  if (!record) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no record (DELETE or empty)' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Forward when:
  //   - INSERT with a status that indicates a fresh entry decision, OR
  //   - UPDATE whose status flipped to 'active' (broker filled) or 'rejected'.
  // Tune this filter to taste. For now we forward all INSERTs and let
  // ClaudeClaw decide priority.
  if (event.type === 'DELETE') {
    return new Response(JSON.stringify({ ok: true, skipped: 'DELETE event' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Build clawos payload. trading-monitor's CLAUDE.md expects:
  //   provider, instrument, side, entry, sl, tp[], raw
  const payload = {
    signal_id: record.signal_id ?? null,
    provider: 'ceddi', // adjust if other providers go through this table
    instrument: 'XAUUSD',
    side: record.direction === 'sell' ? 'sell' : record.direction === 'buy' ? 'buy' : 'unknown',
    entry: record.entry_price !== null && record.entry_price !== undefined ? Number(record.entry_price) : null,
    sl: record.signal_sl_price !== null && record.signal_sl_price !== undefined ? Number(record.signal_sl_price) : null,
    tp: Array.isArray(record.tp_levels) ? record.tp_levels.map((v) => Number(v)) : [],
    signal_type: record.signal_type ?? null,
    status: record.status ?? null,
    db_event: event.type,
    raw: `signals.${event.type} signal_id=${record.signal_id} ${record.direction ?? '?'} entry=${record.entry_price ?? '?'} sl=${record.signal_sl_price ?? '?'} status=${record.status ?? '?'}`,
  };

  const body = JSON.stringify(payload);

  // Compute HMAC-SHA256 hex over the body bytes.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sigHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Forward to clawos webhook.
  let upstreamStatus: number | null = null;
  let upstreamBody: string | null = null;
  try {
    const res = await fetch(CLAWOS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': `sha256=${sigHex}`,
        'user-agent': 'supabase-edge:clawos-trading-monitor',
      },
      body,
    });
    upstreamStatus = res.status;
    upstreamBody = await res.text().catch(() => null);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'fetch to clawos failed', detail: String(err), payload }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: upstreamStatus !== null && upstreamStatus < 400,
      upstream_status: upstreamStatus,
      upstream_body: upstreamBody,
      forwarded_signal_id: record.signal_id ?? null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
