// Slice 9 Wave 0 — Activity feed contract test.
//
// Exercises the new endpoints + queue-side provenance plumbing:
//   - GET    /api/activity                  filters: source, source_id,
//                                            agent, status, since, limit,
//                                            cursor
//   - POST   /api/hooks/:slug               canonical public webhook path
//   - POST   /api/watchers/webhook/:slug    legacy alias (still works)
//
// Plus the underlying invariant: a webhook fire stamps source='webhook'
// and source_id=<slug> on every mission_task it queues; mission-cli paths
// land as source='mission_cli'; manual dashboard creates land as
// source='manual'; legacy NULL rows still load.
//
// Hono's `app.request()` keeps the test in-process so no port is opened
// and the env-vars stay scoped to this file.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-9-activity-'));
const TMP_DB = path.join(TMP_DIR, 'test.db');

// Mock the watchers module BEFORE importing the dashboard so the dashboard
// route handlers see our stub watcher list. This avoids touching the real
// watchers.yaml on disk (which other contract tests also override and the
// shared file race kicks them to failure when the suite runs in parallel).
//
// runActions stays partially-real: we delegate to the real
// runActions for the source/source_id propagation invariant we want to
// test, but we substitute in our own queueMission via a thin re-export so
// the row lands in TMP_DB.
vi.mock('./watchers.js', async () => {
  const actual = await vi.importActual<typeof import('./watchers.js')>('./watchers.js');
  const stubs = [
    {
      name: 'test-activity-hook',
      type: 'webhook' as const,
      slug: 'test-activity',
      secret_env: 'TEST_ACTIVITY_SECRET',
      mode: 'run' as const,
      actions: [
        {
          'queue-mission': {
            agent: 'meta',
            title: 'Test queued via webhook',
            prompt: 'payload: {payload_raw}',
          },
        },
      ],
    },
  ];
  return {
    ...actual,
    loadWebhookWatcher: (slug: string) => stubs.find((s) => s.slug === slug) || null,
    listWebhookWatchers: () => stubs,
    // runActions: keep the REAL implementation so the source/source_id
    // pair flows from the dashboard handler all the way to the
    // mission_tasks INSERT. The real path uses storeDbPath() which
    // honors CLAUDECLAW_STORE_DB_PATH, so writes land in TMP_DB.
  };
});

import { _initTestDatabaseAtPath, createMissionTask } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

let app: Hono;

beforeAll(() => {
  process.env.CLAUDECLAW_STORE_DB_PATH = TMP_DB;
  process.env.DASHBOARD_TOKEN = TOKEN;
  process.env.TEST_ACTIVITY_SECRET = 'unit-test-secret';
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  // Use a fresh DB file per test so seeded ids don't collide and so the
  // dashboard's connection (separate Database instance) sees the same
  // schema we wrote. _initTestDatabaseAtPath also runs migrations so the
  // new source/source_id columns are present.
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  _initTestDatabaseAtPath(TMP_DB);
});

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function authUrl(p: string): string {
  return p.includes('?') ? `${p}&token=${TOKEN}` : `${p}?token=${TOKEN}`;
}

describe('Slice 9 Wave 0: schema + queue-side provenance', () => {
  it('createMissionTask records source + source_id', () => {
    createMissionTask('row1', 'manual create', 'p', 'main', 'dashboard', 0, 'manual', null);
    createMissionTask('row2', 'cli create', 'p', 'main', 'cli', 0, 'mission_cli', null);
    createMissionTask('row3', 'workflow stage', 'p', 'main', 'workflow', 5, 'workflow', 'wfr_abc');
    createMissionTask('row4', 'legacy', 'p', 'main'); // no source — legacy NULL path

    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    const rows = db.prepare(
      'SELECT id, source, source_id FROM mission_tasks ORDER BY id',
    ).all() as Array<{ id: string; source: string | null; source_id: string | null }>;
    db.close();

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.row1).toEqual({ id: 'row1', source: 'manual', source_id: null });
    expect(byId.row2).toEqual({ id: 'row2', source: 'mission_cli', source_id: null });
    expect(byId.row3).toEqual({ id: 'row3', source: 'workflow', source_id: 'wfr_abc' });
    // Legacy NULL row continues to load — no NOT NULL constraint added.
    expect(byId.row4).toEqual({ id: 'row4', source: null, source_id: null });
  });
});

describe('Slice 9 Wave 0: POST /api/hooks/:slug (canonical) + alias', () => {
  it('canonical path queues with source=webhook, source_id=<slug>', async () => {
    const body = JSON.stringify({ thing: 1 });
    const sig = sign('unit-test-secret', body);
    const res = await app.request('/api/hooks/test-activity', {
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
    expect(j.queued_mission_tasks.length).toBeGreaterThan(0);

    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    const row = db.prepare(
      'SELECT source, source_id, assigned_agent FROM mission_tasks WHERE id = ?',
    ).get(j.queued_mission_tasks[0]) as { source: string; source_id: string; assigned_agent: string };
    db.close();

    expect(row.source).toBe('webhook');
    expect(row.source_id).toBe('test-activity');
    expect(row.assigned_agent).toBe('meta');
  });

  it('legacy alias path /api/watchers/webhook/:slug also queues correctly', async () => {
    const body = JSON.stringify({ thing: 2 });
    const sig = sign('unit-test-secret', body);
    const res = await app.request('/api/watchers/webhook/test-activity', {
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
    expect(j.queued_mission_tasks.length).toBeGreaterThan(0);
  });

  it('canonical path returns 401 on missing HMAC (parity with alias)', async () => {
    const res = await app.request('/api/hooks/test-activity', {
      method: 'POST',
      body: JSON.stringify({ x: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });
});

describe('Slice 9 Wave 0: GET /api/activity', () => {
  function seed(): void {
    const now = Math.floor(Date.now() / 1000);
    createMissionTask('a1', 'webhook one', 'p', 'main', 'watcher', 50, 'webhook', 'test-activity');
    createMissionTask('a2', 'workflow stage', 'p', 'main', 'workflow', 5, 'workflow', 'wfr_xyz');
    createMissionTask('a3', 'manual one', 'p', 'meta', 'dashboard', 0, 'manual', null);
    createMissionTask('a4', 'cli one', 'p', 'comms', 'cli', 0, 'mission_cli', null);
    createMissionTask('a5', 'legacy', 'p', 'main');
    void now;
  }

  it('returns activity rows with source_label populated', async () => {
    seed();
    const res = await app.request(authUrl('/api/activity'), { method: 'GET' });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(Array.isArray(j.activity)).toBe(true);
    expect(j.activity.length).toBe(5);
    const byId = Object.fromEntries(j.activity.map((r: any) => [r.id, r]));
    // Webhook row labels with the watcher slug + name.
    expect(byId.a1.source).toBe('webhook');
    expect(byId.a1.source_label).toContain('test-activity');
    // Workflow row falls back to source_id label when run not present.
    expect(byId.a2.source).toBe('workflow');
    expect(byId.a2.source_label).toContain('wfr_xyz');
    // Manual + cli land on stable labels.
    expect(byId.a3.source).toBe('manual');
    expect(byId.a3.source_label).toBe('manual (dashboard)');
    expect(byId.a4.source_label).toBe('mission-cli');
    // Legacy NULL row gets the catch-all.
    expect(byId.a5.source_label).toBe('manual / unknown');
  });

  it('filters by source (single + multi)', async () => {
    seed();
    const r1 = await app.request(authUrl('/api/activity?source=webhook'), { method: 'GET' });
    const j1: any = await r1.json();
    expect(j1.activity.length).toBe(1);
    expect(j1.activity[0].id).toBe('a1');

    const r2 = await app.request(authUrl('/api/activity?source=manual&source=mission_cli'), { method: 'GET' });
    const j2: any = await r2.json();
    expect(j2.activity.length).toBe(2);
    expect(new Set(j2.activity.map((r: any) => r.id))).toEqual(new Set(['a3', 'a4']));
  });

  it('filters by source_id', async () => {
    seed();
    const r = await app.request(authUrl('/api/activity?source_id=test-activity'), { method: 'GET' });
    const j: any = await r.json();
    expect(j.activity.length).toBe(1);
    expect(j.activity[0].id).toBe('a1');
  });

  it('filters by agent', async () => {
    seed();
    const r = await app.request(authUrl('/api/activity?agent=meta'), { method: 'GET' });
    const j: any = await r.json();
    expect(j.activity.length).toBe(1);
    expect(j.activity[0].id).toBe('a3');
  });

  it('filters by status (multi)', async () => {
    seed();
    // All seeded rows are 'queued'. Verify status=queued returns all 5,
    // and status=running returns none.
    const r1 = await app.request(authUrl('/api/activity?status=queued'), { method: 'GET' });
    const j1: any = await r1.json();
    expect(j1.activity.length).toBe(5);

    const r2 = await app.request(authUrl('/api/activity?status=running'), { method: 'GET' });
    const j2: any = await r2.json();
    expect(j2.activity.length).toBe(0);
  });

  it('filters by since (unix seconds)', async () => {
    seed();
    const future = Math.floor(Date.now() / 1000) + 10_000;
    const r = await app.request(authUrl(`/api/activity?since=${future}`), { method: 'GET' });
    const j: any = await r.json();
    expect(j.activity.length).toBe(0);
  });

  it('paginates via limit + cursor', async () => {
    seed();
    const r1 = await app.request(authUrl('/api/activity?limit=2'), { method: 'GET' });
    const j1: any = await r1.json();
    expect(j1.activity.length).toBe(2);
    expect(j1.next_cursor).not.toBeNull();

    const r2 = await app.request(authUrl(`/api/activity?limit=2&cursor=${j1.next_cursor}`), { method: 'GET' });
    const j2: any = await r2.json();
    expect(j2.activity.length).toBe(2);
    // The two pages must be disjoint.
    const ids1 = new Set(j1.activity.map((r: any) => r.id));
    const ids2 = new Set(j2.activity.map((r: any) => r.id));
    for (const id of ids2) expect(ids1.has(id as string)).toBe(false);
  });

  it('rejects invalid source / status / since with 400', async () => {
    const r1 = await app.request(authUrl('/api/activity?source=bogus'), { method: 'GET' });
    expect(r1.status).toBe(400);
    const r2 = await app.request(authUrl('/api/activity?status=zomg'), { method: 'GET' });
    expect(r2.status).toBe(400);
    const r3 = await app.request(authUrl('/api/activity?since=notanumber'), { method: 'GET' });
    expect(r3.status).toBe(400);
  });

  it('refuses unauthenticated requests with 401', async () => {
    seed();
    const r = await app.request('/api/activity', { method: 'GET' });
    expect(r.status).toBe(401);
  });
});

// No file teardown — the vi.mock above swaps loadWebhookWatcher with a
// stub list, so this test never touches watchers.yaml on disk.
