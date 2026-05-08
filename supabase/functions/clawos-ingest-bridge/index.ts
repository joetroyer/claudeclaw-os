// Supabase Edge Function — clawos-ingest-bridge
//
// Source table:    analysis.signals_l1     (observation-only L1 ingest)
// clawos watcher:  trading-monitor-ingest   (slug: trading-monitor-ingest)
// Behaviour:       Forward every INSERT as a MINIMAL payload (signal_id +
//                  table + schema). Agent fetches fresh row data from
//                  Supabase via the analysis schema PostgREST endpoint.
// Secret env:      TRADING_MONITOR_INGEST_SECRET
//
// Why minimal payload — see ../README.md "Minimal payload pattern".
//
// L1 rows are immutable so a snapshot would also be fine, but we use the
// same minimal-payload pattern as the ceddi-bridge for consistency. Agent
// queries `analysis.signals_l1` via PostgREST with Accept-Profile header.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

const CLAWOS_WEBHOOK_URL =
  Deno.env.get('CLAWOS_WEBHOOK_URL') ||
  'https://clawos.joetroyer.com/api/watchers/webhook/trading-monitor-ingest';

const SECRET = Deno.env.get('TRADING_MONITOR_INGEST_SECRET') || '';

const PROVIDER_ALLOWLIST = (Deno.env.get('PROVIDER_ALLOWLIST') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface SupabaseDbWebhookEvent {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema?: string;
  record?: Record<string, unknown>;
  old_record?: Record<string, unknown>;
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

  if (event.type !== 'INSERT') {
    return new Response(
      JSON.stringify({ ok: true, skipped: `${event.type} ignored — L1 rows are immutable` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const r = event.record;
  if (!r) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no record' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const signal_id = r.signal_id as string | undefined;
  const provider = (r.provider as string | undefined) ?? 'unknown';
  if (!signal_id) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no signal_id on record' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (PROVIDER_ALLOWLIST.length > 0 && !PROVIDER_ALLOWLIST.includes(provider)) {
    return new Response(
      JSON.stringify({ ok: true, skipped: `provider=${provider} not in allowlist` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  // Minimal payload — agent fetches fresh data from Supabase.
  const payload = {
    bridge: 'clawos-ingest-bridge',
    schema: event.schema || 'analysis',
    table: event.table || 'signals_l1',
    db_event: event.type,
    signal_id,
    provider, // included for the mission title only; agent re-queries to verify.
  };

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
      forwarded_signal_id: signal_id,
      provider,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
