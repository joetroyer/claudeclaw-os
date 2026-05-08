/**
 * Slice 9 Wave 0 — backend foundation + CF Access path rename · e2e spec.
 *
 * Verifies the new public ingress path, the activity feed, and the
 * provenance plumbing. There is NO new UI surface in Wave 0 — Wave 1
 * builds the Activity page on top of /api/activity.
 *
 * Pre-conditions:
 *   1. The bot has been restarted at least once after this branch
 *      lands so runMigrations() applied the source/source_id columns.
 *   2. DASHBOARD_TOKEN env var is set (or the run goes through CF Access).
 *   3. TRADING_MONITOR_INGEST_SECRET is set so we can sign a synthetic
 *      webhook payload.
 *   4. The dashboard is running (clawos.joetroyer.com or localhost:3141).
 *
 * The actual run uses Playwright MCP tools; this file documents the
 * expected behavior so it can be replayed under a headless CI runner
 * later. Each `test()` is a stand-alone assertion.
 */
import { test, expect } from '@playwright/test';
import crypto from 'crypto';

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3141';
const TOKEN = process.env.DASHBOARD_TOKEN ?? '';
const HOOK_SECRET = process.env.TRADING_MONITOR_INGEST_SECRET ?? '';

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test.describe('Slice 9 Wave 0 — Activity feed + path rename', () => {
  test('new canonical webhook path /api/hooks/:slug accepts a signed payload', async ({ request }) => {
    const body = JSON.stringify({
      schema: 'analysis', table: 'signals_l1',
      provider: 'goldsignals_swing',
      signal_id: `synthetic-${Date.now()}`,
    });
    const sig = sign(HOOK_SECRET, body);
    const res = await request.post(`${DASHBOARD}/api/hooks/trading-monitor-ingest`, {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });
    expect(res.status()).toBeLessThan(300);
    const j = await res.json();
    expect(j.ok).toBe(true);
    // The fired action queues a mission_task; we verify provenance via
    // /api/activity below.
    expect(Array.isArray(j.queued_mission_tasks)).toBe(true);
  });

  test('legacy alias /api/watchers/webhook/:slug still accepts signed payloads', async ({ request }) => {
    const body = JSON.stringify({
      schema: 'analysis', table: 'signals_l1',
      provider: 'gold_scalping',
      signal_id: `synthetic-alias-${Date.now()}`,
    });
    const sig = sign(HOOK_SECRET, body);
    const res = await request.post(`${DASHBOARD}/api/watchers/webhook/trading-monitor-ingest`, {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('GET /api/activity returns rows with source_label populated', async ({ request }) => {
    const res = await request.get(`${DASHBOARD}/api/activity?token=${TOKEN}&limit=10`);
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(Array.isArray(j.activity)).toBe(true);
    for (const row of j.activity) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('agent_id');
      expect(row).toHaveProperty('title');
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('source_label');
      // duration_ms is null for queued/running rows; populated for completed.
      if (row.status === 'completed' || row.status === 'failed') {
        expect(row.duration_ms).not.toBeNull();
      }
    }
  });

  test('GET /api/activity?source=webhook narrows to webhook-fired rows', async ({ request }) => {
    const res = await request.get(`${DASHBOARD}/api/activity?token=${TOKEN}&source=webhook&limit=10`);
    expect(res.status()).toBe(200);
    const j = await res.json();
    for (const row of j.activity) expect(row.source).toBe('webhook');
  });

  test('GET /api/activity rejects unknown filter values with 400', async ({ request }) => {
    const res = await request.get(`${DASHBOARD}/api/activity?token=${TOKEN}&source=bogus`);
    expect(res.status()).toBe(400);
  });

  test('GET /api/activity refuses unauthenticated requests', async ({ request }) => {
    const res = await request.get(`${DASHBOARD}/api/activity`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/activity paginates via cursor', async ({ request }) => {
    const r1 = await request.get(`${DASHBOARD}/api/activity?token=${TOKEN}&limit=2`);
    const j1 = await r1.json();
    if (!j1.next_cursor) {
      // Not enough data to paginate — skip rather than fail the suite.
      test.skip(true, 'fewer than 2 mission_tasks rows in DB');
      return;
    }
    const r2 = await request.get(
      `${DASHBOARD}/api/activity?token=${TOKEN}&limit=2&cursor=${j1.next_cursor}`,
    );
    const j2 = await r2.json();
    const ids1 = new Set(j1.activity.map((r: any) => r.id));
    for (const row of j2.activity) {
      expect(ids1.has(row.id)).toBe(false);
    }
  });

  test('webhook fire stamps source=webhook + source_id=<slug> on the queued row', async ({ request }) => {
    // Fire a synthetic webhook then read /api/activity to confirm the new
    // row carries the right provenance pair.
    const body = JSON.stringify({
      schema: 'analysis', table: 'signals_l1',
      provider: 'goldsignals_intraday',
      signal_id: `provenance-check-${Date.now()}`,
    });
    const sig = sign(HOOK_SECRET, body);
    const fire = await request.post(`${DASHBOARD}/api/hooks/trading-monitor-ingest`, {
      data: body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });
    const f = await fire.json();
    if (!f.queued_mission_tasks?.[0]) {
      test.skip(true, 'webhook did not queue a mission task (mode != run/test?)');
      return;
    }
    const newId = f.queued_mission_tasks[0];

    const r = await request.get(
      `${DASHBOARD}/api/activity?token=${TOKEN}&source=webhook&source_id=trading-monitor-ingest&limit=20`,
    );
    const j = await r.json();
    const found = j.activity.find((row: any) => row.id === newId);
    expect(found).toBeDefined();
    expect(found.source).toBe('webhook');
    expect(found.source_id).toBe('trading-monitor-ingest');
  });
});
