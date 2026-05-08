// Supabase Edge Function — clawos-ingest-bridge
//
// Source table:    analysis.signals_l1     (observation-only L1 ingest)
// clawos watcher:  trading-monitor-ingest   (slug: trading-monitor-ingest)
// Behaviour:       Forward every INSERT for ingest_only providers
//                  (GoldSignals.io VIP Intraday/Swing, Gold Scalping & Zones,
//                  future ingest_only sources). Default priority `low`,
//                  log only, no Telegram ping.
// Secret env:      TRADING_MONITOR_INGEST_SECRET
//
// Why this bridge exists separately from clawos-ceddi-bridge:
//   analysis.signals_l1 → all ingest_only providers (currently 4 known
//   providers per migration 066: ceddi, gold_scalping, goldsignals_swing,
//   goldsignals_intraday). These are observation events; we don't want
//   them paging Joe's phone the way ceddi live signals would. Different
//   default priority + different downstream prompt template.
//
// Adding a new provider:
//   See ../README.md "Pattern: adding a new provider within an existing
//   bridge". TL;DR — if the new provider writes the same signals_l1 row
//   shape, this function needs zero code change. Just widen the
//   `provider` CHECK constraint via a goldbot migration and add the row
//   in `signal_channels`.
//
// Deploy:
//   supabase functions deploy clawos-ingest-bridge
//   supabase secrets set TRADING_MONITOR_INGEST_SECRET=<value-from-.env>
//
// Wire (Supabase dashboard → Database → Webhooks):
//   - Schema: analysis      (must explicitly select this — the analysis
//                            schema isn't exposed via PostgREST by default,
//                            but Database Webhooks operate at the trigger
//                            layer and can target any schema)
//   - Table:  signals_l1
//   - Events: ☑ Insert       (skip Update + Delete — L1 rows are immutable)
//   - Type:   Supabase Edge Functions
//   - Edge Function: clawos-ingest-bridge

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

const CLAWOS_WEBHOOK_URL =
  Deno.env.get('CLAWOS_WEBHOOK_URL') ||
  'https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor-ingest';

const SECRET = Deno.env.get('TRADING_MONITOR_INGEST_SECRET') || '';

// Optional comma-separated allowlist of providers to forward. Default empty
// = forward all known providers. Set to e.g. "goldsignals_swing,gold_scalping"
// to narrow during a smoke test.
const PROVIDER_ALLOWLIST = (Deno.env.get('PROVIDER_ALLOWLIST') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface L1Record {
  signal_id?: string;
  provider?: string;
  source_channel_id?: string;
  source_msg_id?: number;
  posted_at?: string;
  direction?: 'BUY' | 'SELL' | string;
  entry_low?: number | string | null;
  entry_high?: number | string | null;
  entry_mid?: number | string | null;
  tp_levels?: Array<number | string> | null;
  sl?: number | string | null;
  is_split_message?: boolean;
  is_buy_now?: boolean;
  parser_warnings?: string[] | null;
  raw_text?: string;
}

interface SupabaseDbWebhookEvent {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema?: string;
  record?: L1Record;
  old_record?: L1Record;
}

function shouldForward(event: SupabaseDbWebhookEvent): { ok: true } | { ok: false; reason: string } {
  if (event.type !== 'INSERT') return { ok: false, reason: `${event.type} ignored — L1 rows are immutable` };
  if (!event.record) return { ok: false, reason: 'no record' };
  if (PROVIDER_ALLOWLIST.length > 0) {
    const p = event.record.provider || '';
    if (!PROVIDER_ALLOWLIST.includes(p)) {
      return { ok: false, reason: `provider=${p} not in allowlist` };
    }
  }
  return { ok: true };
}

function mapRecord(event: SupabaseDbWebhookEvent): Record<string, unknown> {
  const r = event.record!;
  const sideRaw = (r.direction || '').toUpperCase();
  return {
    bridge: 'clawos-ingest-bridge',
    db_event: event.type,
    signal_id: r.signal_id ?? null,
    provider: r.provider ?? 'unknown',
    instrument: 'XAUUSD',
    side: sideRaw === 'SELL' ? 'sell' : sideRaw === 'BUY' ? 'buy' : 'unknown',
    entry: r.entry_mid !== null && r.entry_mid !== undefined ? Number(r.entry_mid) : null,
    entry_range: [
      r.entry_low !== null && r.entry_low !== undefined ? Number(r.entry_low) : null,
      r.entry_high !== null && r.entry_high !== undefined ? Number(r.entry_high) : null,
    ],
    sl: r.sl !== null && r.sl !== undefined ? Number(r.sl) : null,
    tp: Array.isArray(r.tp_levels) ? r.tp_levels.map((v) => Number(v)) : [],
    is_split_message: r.is_split_message ?? false,
    is_buy_now: r.is_buy_now ?? false,
    parser_warnings: Array.isArray(r.parser_warnings) ? r.parser_warnings : [],
    posted_at: r.posted_at ?? null,
    source_channel_id: r.source_channel_id ?? null,
    source_msg_id: r.source_msg_id ?? null,
    raw: r.raw_text ?? `signals_l1.INSERT provider=${r.provider} ${sideRaw} entry=${r.entry_mid ?? '?'}`,
  };
}

async function hmacSha256Hex(key: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!SECRET) {
    return new Response(JSON.stringify({ error: 'TRADING_MONITOR_INGEST_SECRET not configured' }), {
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

  const gate = shouldForward(event);
  if (!gate.ok) {
    return new Response(JSON.stringify({ ok: true, skipped: gate.reason }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const payload = mapRecord(event);
  const body = JSON.stringify(payload);
  const sig = await hmacSha256Hex(SECRET, body);

  let upstreamStatus: number | null = null;
  let upstreamBody: string | null = null;
  try {
    const res = await fetch(CLAWOS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': `sha256=${sig}`,
        'user-agent': 'supabase-edge:clawos-ingest-bridge',
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
      forwarded_signal_id: event.record?.signal_id ?? null,
      provider: event.record?.provider ?? null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
