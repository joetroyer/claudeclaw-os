// Supabase Edge Function — clawos-ceddi-bridge
//
// Source table:    public.signals          (live broker dispatch pipeline)
// clawos watcher:  trading-monitor          (slug: trading-monitor)
// Behaviour:       Forward INSERT + status-flip events; default priority
//                  `medium`; agent may escalate to `high` based on
//                  `lab-query-channel-credibility` skill.
// Secret env:      TRADING_MONITOR_SECRET   (clawos .env + supabase secrets)
//
// Why this bridge exists separately from clawos-ingest-bridge:
//   public.signals → ceddi only (live broker dispatch). Mistakes here
//   trigger Telegram pings + on-call attention. Different priority defaults
//   and probably different agent prompt template than the ingest_only path.
//   See ../README.md for the "one-bridge-per-table" rationale.
//
// Deploy:
//   supabase functions deploy clawos-ceddi-bridge
//   supabase secrets set TRADING_MONITOR_SECRET=<value-from-clawos-.env>
//
// Wire (Supabase dashboard → Database → Webhooks):
//   - Table:  public.signals
//   - Events: ☑ Insert  ☑ Update     (skip Delete)
//   - Type:   Supabase Edge Functions
//   - Edge Function: clawos-ceddi-bridge
//
// Tuning what fires:
//   - The default forwards every INSERT and every UPDATE. To narrow, edit
//     `shouldForward()` below — e.g. only forward UPDATEs whose status
//     transitioned to `active` or `complete`.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

const CLAWOS_WEBHOOK_URL =
  Deno.env.get('CLAWOS_WEBHOOK_URL') ||
  'https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor';

const SECRET = Deno.env.get('TRADING_MONITOR_SECRET') || '';

interface SignalRecord {
  signal_id?: string;
  signal_type?: string;
  status?: string;
  direction?: string;
  entry_price?: number | string | null;
  intended_lots?: number | string | null;
  filled_lots?: number | string | null;
  signal_sl_price?: number | string | null;
  emergency_sl_price?: number | string | null;
  tp_levels?: Array<number | string> | null;
  tps_hit?: number[] | null;
  exit_reason?: string | null;
  final_pnl?: number | string | null;
  source_channel_kind?: string | null;
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

function shouldForward(event: SupabaseDbWebhookEvent): { ok: true } | { ok: false; reason: string } {
  if (event.type === 'DELETE') return { ok: false, reason: 'DELETE event' };
  if (!event.record) return { ok: false, reason: 'no record' };

  // The signals table only accepts ceddi today (other live channels would
  // need their own kind here). Reject anything we weren't expecting.
  const kind = event.record.source_channel_kind;
  if (kind && kind !== 'ceddi' && kind !== 'unknown') {
    return { ok: false, reason: `source_channel_kind=${kind} not handled by ceddi-bridge` };
  }

  return { ok: true };
}

function mapRecord(event: SupabaseDbWebhookEvent): Record<string, unknown> {
  const r = event.record!;
  return {
    bridge: 'clawos-ceddi-bridge',
    db_event: event.type,
    signal_id: r.signal_id ?? null,
    provider: r.source_channel_kind || 'ceddi',
    instrument: 'XAUUSD',
    side: r.direction === 'sell' ? 'sell' : r.direction === 'buy' ? 'buy' : 'unknown',
    entry: r.entry_price !== null && r.entry_price !== undefined ? Number(r.entry_price) : null,
    sl: r.signal_sl_price !== null && r.signal_sl_price !== undefined ? Number(r.signal_sl_price) : null,
    tp: Array.isArray(r.tp_levels) ? r.tp_levels.map((v) => Number(v)) : [],
    tps_hit: Array.isArray(r.tps_hit) ? r.tps_hit : [],
    signal_type: r.signal_type ?? null,
    status: r.status ?? null,
    exit_reason: r.exit_reason ?? null,
    final_pnl: r.final_pnl !== null && r.final_pnl !== undefined ? Number(r.final_pnl) : null,
    raw: `signals.${event.type} signal_id=${r.signal_id} status=${r.status ?? '?'} ${r.direction ?? '?'} entry=${r.entry_price ?? '?'} sl=${r.signal_sl_price ?? '?'}`,
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
        'user-agent': 'supabase-edge:clawos-ceddi-bridge',
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
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
