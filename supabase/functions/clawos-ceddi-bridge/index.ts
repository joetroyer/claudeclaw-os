// Supabase Edge Function — clawos-ceddi-bridge
//
// Source table:    public.signals          (live broker dispatch pipeline)
// clawos watcher:  trading-monitor          (slug: trading-monitor)
// Behaviour:       Forward INSERT + status-flip events as MINIMAL payloads.
//                  The agent fetches fresh row data from Supabase when it
//                  processes the mission task — so it always sees the
//                  latest status, not the snapshot at trigger time.
// Secret env:      TRADING_MONITOR_SECRET   (clawos .env + supabase secrets)
//
// Why minimal payload (signal_id only, not field snapshot):
//   1. Live signals evolve. status flips filling → active → complete with
//      possibly several intermediate UPDATEs. By the time the agent runs,
//      the row may have moved on. Lookup-on-process gives fresh data.
//   2. Smaller wire payload, less chance of HMAC body-mismatch issues.
//   3. Agent reasoning isn't pinned to a stale snapshot stored in
//      mission_tasks.prompt forever.
//
// Trade-off: the agent must reach Supabase. Service-role key + PostgREST
// path is the recipe; analysis schema is now exposed.
//
// Deploy:
//   supabase functions deploy clawos-ceddi-bridge --no-verify-jwt
//   supabase secrets set TRADING_MONITOR_SECRET=<value-from-clawos-.env>
//
// Wire (Supabase dashboard → Database → Webhooks):
//   - Table:  public.signals
//   - Events: ☑ Insert  ☑ Update     (skip Delete)
//   - Type:   Supabase Edge Functions
//   - Function: clawos-ceddi-bridge

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';

// Slice 9 Wave 0: clawos public webhook surface moved from
// /api/watchers/webhook/<slug> to /api/hooks/<slug>. The CF Access bypass
// app is configured for /api/hooks/* — pointing the bridge at the legacy
// alias would still work server-side, but the alias is on borrowed time
// and any future CF Access tightening would fence it. New default lands
// on the canonical path.
const CLAWOS_WEBHOOK_URL =
  Deno.env.get('CLAWOS_WEBHOOK_URL') ||
  'https://clawos.joetroyer.com/api/hooks/trading-monitor';

const SECRET = Deno.env.get('TRADING_MONITOR_SECRET') || '';

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

  if (event.type === 'DELETE') {
    return new Response(JSON.stringify({ ok: true, skipped: 'DELETE event' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const r = event.record;
  if (!r) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no record' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const signal_id = r.signal_id as string | undefined;
  if (!signal_id) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no signal_id on record' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Reject non-ceddi rows (this bridge is for the live ceddi pipeline).
  const kind = r.source_channel_kind as string | null | undefined;
  if (kind && kind !== 'ceddi' && kind !== 'unknown') {
    return new Response(
      JSON.stringify({ ok: true, skipped: `source_channel_kind=${kind} not handled by ceddi-bridge` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  // Minimal payload — agent fetches fresh data from Supabase.
  const payload = {
    bridge: 'clawos-ceddi-bridge',
    schema: event.schema || 'public',
    table: event.table || 'signals',
    db_event: event.type,
    signal_id,
    // status snapshot for log titles only — agent doesn't trust this; it queries.
    status_at_trigger: (r.status as string | undefined) ?? null,
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
      forwarded_signal_id: signal_id,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
