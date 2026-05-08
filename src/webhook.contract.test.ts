// Slice 2 — Webhook watcher contract test.
//
// Exercises the public POST /api/watchers/webhook/:slug route end-to-end:
//   - HMAC verification (positive + negative)
//   - mode dispatch (test / preview / run)
//   - payload persistence into webhook_payloads
//   - dashboard fire-test endpoint (auth-gated)
//
// Uses Hono's `app.request()` so no port is opened. The DB is in-memory
// via `_initTestDatabase()`. We mock the watcher loader + action runner
// so the test doesn't depend on the real watchers.yaml on disk or a
// real mission_tasks consumer.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

const queueMissionSpy = vi.fn();

// Mock watchers.js BEFORE importing the dashboard so the mock is wired
// at module-load time. Provides two stub watchers covering run + preview
// modes; everything else is forwarded to the real module so substitute()
// etc. still works in case dashboard imports it (it doesn't today).
vi.mock('./watchers.js', () => {
  const stubs: any[] = [
    {
      name: 'trading-monitor-trigger',
      type: 'webhook',
      slug: 'trading-monitor',
      secret_env: 'TRADING_MONITOR_SECRET',
      mode: 'run',
      actions: [
        {
          'queue-mission': {
            agent: 'trading-monitor',
            title: 'Trading signal received',
            prompt: 'Payload: {payload_raw}',
          },
        },
      ],
    },
    {
      name: 'preview-only',
      type: 'webhook',
      slug: 'preview-only',
      secret_env: 'PREVIEW_SECRET',
      mode: 'preview',
      actions: [
        {
          'queue-mission': {
            agent: 'meta',
            title: 'Preview should not fire',
            prompt: '{payload_raw}',
          },
        },
      ],
    },
  ];
  return {
    loadWebhookWatcher: (slug: string) => stubs.find((s) => s.slug === slug) || null,
    listWebhookWatchers: () => stubs,
    runActions: vi.fn(async (actions: any[], _vars: Record<string, unknown>) => {
      queueMissionSpy(actions, _vars);
      return actions
        .map((a: any) => ('queue-mission' in a ? `mock_${Math.random().toString(36).slice(2, 8)}` : null))
        .filter((x: string | null): x is string => !!x);
    }),
  };
});

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';
let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
  queueMissionSpy.mockClear();
});

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('Slice 2 webhook ingress (POST /api/watchers/webhook/:slug)', () => {
  it('rejects unsigned POST in run mode with 401', async () => {
    const body = JSON.stringify({ signal: 'buy' });
    const res = await app.request('/api/watchers/webhook/trading-monitor', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const j: any = await res.json();
    expect(j.error).toBe('unauthorized');
    expect(queueMissionSpy).not.toHaveBeenCalled();
  });

  it('rejects mis-signed POST in run mode with 401', async () => {
    process.env.TRADING_MONITOR_SECRET = 'real-secret';
    const body = JSON.stringify({ signal: 'buy' });
    const wrongSig = sign('wrong-secret', body);
    const res = await app.request('/api/watchers/webhook/trading-monitor', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + wrongSig,
      },
    });
    expect(res.status).toBe(401);
    expect(queueMissionSpy).not.toHaveBeenCalled();
  });

  it('accepts valid HMAC and queues actions in run mode', async () => {
    process.env.TRADING_MONITOR_SECRET = 'real-secret';
    const body = JSON.stringify({ signal: 'buy', instrument: 'XAUUSD' });
    const sig = sign('real-secret', body);
    const res = await app.request('/api/watchers/webhook/trading-monitor', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('run');
    expect(j.payload_id).toBeGreaterThan(0);
    expect(Array.isArray(j.queued_mission_tasks)).toBe(true);
    expect(queueMissionSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts bare-hex signature (no sha256= prefix)', async () => {
    process.env.TRADING_MONITOR_SECRET = 'real-secret';
    const body = JSON.stringify({ alt: 'format' });
    const sig = sign('real-secret', body);
    const res = await app.request('/api/watchers/webhook/trading-monitor', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': sig, // no prefix
      },
    });
    expect(res.status).toBe(200);
  });

  it('preview mode rejects unsigned requests with 401', async () => {
    // HMAC is required uniformly across all 3 modes (test/preview/run).
    // The webhook ingress is a public surface — letting preview accept
    // unsigned requests would let an attacker fill the payload log and
    // probe what slugs are wired without providing a secret.
    const body = JSON.stringify({ shape: 'inspection' });
    const res = await app.request('/api/watchers/webhook/preview-only', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const j: any = await res.json();
    expect(j.error).toBe('unauthorized');
    expect(queueMissionSpy).not.toHaveBeenCalled();
  });

  it('preview mode rejects mis-signed requests with 401', async () => {
    process.env.PREVIEW_SECRET = 'preview-secret';
    const body = JSON.stringify({ shape: 'inspection' });
    const wrongSig = sign('not-the-secret', body);
    const res = await app.request('/api/watchers/webhook/preview-only', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + wrongSig,
      },
    });
    expect(res.status).toBe(401);
    expect(queueMissionSpy).not.toHaveBeenCalled();
  });

  it('preview mode captures payload but does NOT fire actions when HMAC is valid', async () => {
    process.env.PREVIEW_SECRET = 'preview-secret';
    const body = JSON.stringify({ shape: 'inspection' });
    const sig = sign('preview-secret', body);
    const res = await app.request('/api/watchers/webhook/preview-only', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.mode).toBe('preview');
    expect(j.payload_id).toBeGreaterThan(0);
    expect(j.message).toMatch(/preview/i);
    expect(queueMissionSpy).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.request('/api/watchers/webhook/does-not-exist', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid slug format with 400', async () => {
    const res = await app.request('/api/watchers/webhook/has%20space', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});

describe('Slice 2 webhook list + read endpoints (auth-gated)', () => {
  it('requires token to list webhooks', async () => {
    const res = await app.request('/api/watchers/webhook');
    expect(res.status).toBe(401);
  });

  it('lists configured webhook watchers with computed URL', async () => {
    const res = await app.request('/api/watchers/webhook?token=' + TOKEN);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(Array.isArray(j.watchers)).toBe(true);
    const slugs = j.watchers.map((w: any) => w.slug);
    expect(slugs).toContain('trading-monitor');
    expect(slugs).toContain('preview-only');
    const tm = j.watchers.find((w: any) => w.slug === 'trading-monitor');
    expect(tm.webhook_url).toMatch(/\/api\/watchers\/webhook\/trading-monitor$/);
  });

  it('returns last payloads for a slug', async () => {
    process.env.PREVIEW_SECRET = 'preview-secret';
    const body = JSON.stringify({ probe: 1 });
    const sig = sign('preview-secret', body);
    await app.request('/api/watchers/webhook/preview-only', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });
    const res = await app.request(
      '/api/watchers/webhook/preview-only/payloads?token=' + TOKEN,
    );
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(Array.isArray(j.payloads)).toBe(true);
    expect(j.payloads.length).toBeGreaterThan(0);
    expect(j.payloads[0].mode).toBe('preview');
  });

  it('fire-test endpoint writes a test payload and runs actions', async () => {
    const res = await app.request(
      '/api/watchers/webhook/trading-monitor/test?token=' + TOKEN,
      {
        method: 'POST',
        body: JSON.stringify({ test: true }),
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.mode).toBe('test');
    expect(j.payload_id).toBeGreaterThan(0);
    expect(queueMissionSpy).toHaveBeenCalledTimes(1);
  });
});
