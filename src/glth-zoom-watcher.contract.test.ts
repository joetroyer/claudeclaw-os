// GLTH Zoom Recording → ClickUp watcher contract test.
//
// Verifies the public webhook slot end-to-end:
//   - POST /api/hooks/glth-zoom-recording with a valid HMAC queues a
//     mission_task assigned to `ops`, stamped source='webhook' and
//     source_id='glth-zoom-recording'.
//   - Bad signatures get 401 and queue nothing.
//
// Mirrors the strategy of slice-9-activity.contract.test.ts: stub the
// webhook loader so we don't depend on the real watchers.yaml on disk
// (other contract tests share that file and run in parallel), keep the
// real `runActions` so the source/source_id pair flows from the
// dashboard handler through to the mission_tasks INSERT, and point the
// per-call db connection at a tmpfile via CLAUDECLAW_STORE_DB_PATH.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glth-zoom-watcher-'));
const TMP_DB = path.join(TMP_DIR, 'test.db');

vi.mock('./watchers.js', async () => {
  const actual = await vi.importActual<typeof import('./watchers.js')>('./watchers.js');
  const stubs = [
    {
      name: 'glth-zoom-recording',
      type: 'webhook' as const,
      slug: 'glth-zoom-recording',
      secret_env: 'GLTH_ZOOM_SECRET',
      mode: 'run' as const,
      actions: [
        {
          'queue-mission': {
            agent: 'ops',
            title: 'GLTH meeting recap → ClickUp ({payload.duration_minutes}m)',
            prompt: 'Recording: {payload.recording_url}\nMeeting: {payload.meeting_name}',
          },
        },
      ],
    },
  ];
  return {
    ...actual,
    loadWebhookWatcher: (slug: string) => stubs.find((s) => s.slug === slug) || null,
    listWebhookWatchers: () => stubs,
  };
});

import { _initTestDatabaseAtPath } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

let app: Hono;

beforeAll(() => {
  process.env.CLAUDECLAW_STORE_DB_PATH = TMP_DB;
  process.env.DASHBOARD_TOKEN = TOKEN;
  process.env.GLTH_ZOOM_SECRET = 'glth-zoom-unit-test-secret';
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  _initTestDatabaseAtPath(TMP_DB);
});

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('GLTH Zoom watcher (POST /api/hooks/glth-zoom-recording)', () => {
  it('valid HMAC queues an ops mission_task with source=webhook, source_id=glth-zoom-recording', async () => {
    const body = JSON.stringify({
      meeting_name: 'GLTH Sales & Marketing Meeting',
      duration_minutes: 63,
      recording_url:
        'https://us06web.zoom.us/rec/share/YbMWSUnZ1gJCt14pON1ERuGV_OAqu3x_KsJ87pGGn9Bn6s7GqsXNzEjHX7sTvHB_.GKxyMZS3lJVJAv2e',
    });
    const sig = sign('glth-zoom-unit-test-secret', body);

    const res = await app.request('/api/hooks/glth-zoom-recording', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + sig,
      },
    });

    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; mode: string; queued_mission_tasks: string[] };
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('run');
    expect(j.queued_mission_tasks.length).toBe(1);

    // Assert the mission_task row landed with the right provenance + agent.
    // Use require() since the test file already does so via better-sqlite3
    // patterns elsewhere; this isolates the read from the dashboard's own
    // Database handle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    const row = db
      .prepare(
        'SELECT assigned_agent, source, source_id, title, prompt FROM mission_tasks WHERE id = ?',
      )
      .get(j.queued_mission_tasks[0]) as {
        assigned_agent: string;
        source: string;
        source_id: string;
        title: string;
        prompt: string;
      };
    db.close();

    expect(row.assigned_agent).toBe('ops');
    expect(row.source).toBe('webhook');
    expect(row.source_id).toBe('glth-zoom-recording');
    // Spot-check that payload substitution actually fired (the watcher
    // prompt references {payload.recording_url} / {payload.meeting_name}).
    expect(row.title).toContain('63m');
    expect(row.prompt).toContain('GLTH Sales & Marketing Meeting');
    expect(row.prompt).toContain('us06web.zoom.us/rec/share/');
  });

  it('rejects mis-signed POST with 401 and queues nothing', async () => {
    const body = JSON.stringify({
      meeting_name: 'GLTH Sales & Marketing Meeting',
      duration_minutes: 63,
      recording_url: 'https://example.com/zoom',
    });
    const wrongSig = sign('not-the-real-secret', body);

    const res = await app.request('/api/hooks/glth-zoom-recording', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-claudeclaw-signature': 'sha256=' + wrongSig,
      },
    });

    expect(res.status).toBe(401);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM mission_tasks WHERE source_id = 'glth-zoom-recording'").get() as {
        n: number;
      }
    ).n;
    db.close();
    expect(count).toBe(0);
  });
});
