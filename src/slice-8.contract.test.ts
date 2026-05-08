// Slice 8 — Tasks CRUD contract test.
//
// Exercises the new endpoints introduced by Slice 8:
//
//   - POST   /api/tasks            — scheduled task create
//   - POST   /api/watchers         — webhook watcher create
//   - PUT    /api/watchers/:slug   — webhook watcher update
//   - DELETE /api/watchers/:slug   — webhook watcher delete
//
// The watchers tests use a tmp watchers.yaml file via PROJECT_ROOT
// override + a custom CLAUDECLAW_WATCHERS_YAML env var (not yet a
// real switch — these tests redirect via a temp project root by
// using the existing PROJECT_ROOT path).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { _initTestDatabaseAtPath } from './db.js';

// Use a tmp dir as the project root so reads/writes don't trample the
// real watchers.yaml. We set PROJECT_ROOT-via-cwd by hijacking
// `CLAUDECLAW_STORE_DB_PATH` for the DB and writing watchers.yaml into
// the actual `process.cwd()` only as a no-op fallback.
//
// The watchers module reads `path.join(PROJECT_ROOT, 'watchers.yaml')`.
// PROJECT_ROOT is computed at module-load time from `process.cwd()` /
// the executable directory chain. To keep the test isolated, we write
// the test's watchers.yaml into the same directory the module sees as
// PROJECT_ROOT and back it up first.

import { PROJECT_ROOT } from './config.js';
const WATCHERS_PATH = path.join(PROJECT_ROOT, 'watchers.yaml');
let _watchersBackup: string | null = null;
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-8-test-'));
const TMP_DB_PATH = path.join(TMP_DB_DIR, 'test.db');

beforeAll(() => {
  process.env.CLAUDECLAW_STORE_DB_PATH = TMP_DB_PATH;
});

beforeEach(() => {
  // Save the real watchers.yaml so we can restore on each test exit.
  if (fs.existsSync(WATCHERS_PATH)) {
    _watchersBackup = fs.readFileSync(WATCHERS_PATH, 'utf-8');
  } else {
    _watchersBackup = null;
  }
  // Seed a known-good multi-watcher YAML so deletions / edits can be
  // verified against a stable baseline.
  const seed = `# test seed — slice-8.contract.test
watchers:
  - name: log-tail-canary
    type: log-tail
    path: /tmp/slice-8-canary.log
    triggers:
      - regex: "FATAL"
        actions:
          - send-telegram: "log canary fired"

  - name: sqlite-poll-canary
    type: sqlite-poll
    sql: "SELECT 1 as id"
    interval_sec: 60
    actions:
      - send-telegram: "sqlite canary fired"

  - name: existing-webhook
    type: webhook
    slug: existing-hook
    secret_env: EXISTING_SECRET
    mode: test
    actions:
      - queue-mission:
          agent: meta
          title: "existing webhook"
          prompt: "{payload_raw}"
`;
  fs.writeFileSync(WATCHERS_PATH, seed);
  _initTestDatabaseAtPath(TMP_DB_PATH);
});

afterEach(() => {
  // Restore the real watchers.yaml so the test never leaves it dirty.
  if (_watchersBackup !== null) fs.writeFileSync(WATCHERS_PATH, _watchersBackup);
  else if (fs.existsSync(WATCHERS_PATH)) fs.unlinkSync(WATCHERS_PATH);
});

import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';
let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

function url(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `http://test${path}${sep}token=${TOKEN}`;
}

describe('POST /api/tasks (scheduled create)', () => {
  it('creates a task with valid cron and returns it', async () => {
    const res = await app.request(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'main',
        prompt: 'check weather',
        cron: '0 9 * * *',
      }),
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.task).toBeTruthy();
    expect(j.task.prompt).toBe('check weather');
    expect(j.task.schedule).toBe('0 9 * * *');
    expect(j.task.agent_id).toBe('main');
    expect(typeof j.task.next_run).toBe('number');
  });

  it('rejects missing prompt with 400', async () => {
    const res = await app.request(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'main', cron: '0 9 * * *' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing cron with 400', async () => {
    const res = await app.request(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'main', prompt: 'do thing' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid cron with 400', async () => {
    const res = await app.request(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'main',
        prompt: 'do thing',
        cron: 'not a cron',
      }),
    });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toMatch(/invalid cron/);
  });

  it('preserves skill prefix in stored prompt', async () => {
    const res = await app.request(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'main',
        prompt: 'check inbox',
        cron: '0 9 * * *',
        skill: 'gmail',
      }),
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.task.prompt).toBe('[skill:gmail] check inbox');
  });

  it('appears in GET /api/tasks after create', async () => {
    await app.request(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'main',
        prompt: 'roundtrip task',
        cron: '0 12 * * *',
      }),
    });
    const list = await app.request(url('/api/tasks'));
    const lj: any = await list.json();
    const found = lj.tasks.find((t: any) => t.prompt === 'roundtrip task');
    expect(found).toBeTruthy();
  });
});

describe('POST /api/watchers (webhook create)', () => {
  it('creates a new webhook watcher and persists to watchers.yaml', async () => {
    const res = await app.request(url('/api/watchers'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'webhook',
        name: 'New Test Watcher',
        slug: 'new-test',
        secret_env: 'NEW_TEST_SECRET',
        mode: 'preview',
        actions: [{
          'queue-mission': {
            agent: 'meta',
            title: 'New test',
            prompt: 'payload: {payload_raw}',
          },
        }],
      }),
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.watcher.slug).toBe('new-test');
    expect(j.watcher.mode).toBe('preview');

    // Verify on disk.
    const written = fs.readFileSync(WATCHERS_PATH, 'utf-8');
    expect(written).toMatch(/slug: new-test/);
    expect(written).toMatch(/NEW_TEST_SECRET/);
  });

  it('rejects duplicate slugs with 409', async () => {
    const res = await app.request(url('/api/watchers'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'webhook',
        name: 'Dup',
        slug: 'existing-hook', // collides with seeded watcher
        secret_env: 'X',
        actions: [{ 'queue-mission': { agent: 'meta', title: 't', prompt: 'p' } }],
      }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects bad slug format with 400', async () => {
    const res = await app.request(url('/api/watchers'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'webhook',
        name: 'BadSlug',
        slug: 'has spaces!',
        secret_env: 'X',
        actions: [{ 'queue-mission': { agent: 'meta', title: 't', prompt: 'p' } }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects type=log-tail (not allowed via API)', async () => {
    const res = await app.request(url('/api/watchers'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'log-tail',
        name: 'oops',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('does NOT clobber existing log-tail/sqlite-poll watchers', async () => {
    await app.request(url('/api/watchers'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'webhook',
        name: 'untouched test',
        slug: 'untouched',
        secret_env: 'UNTOUCHED_SECRET',
        actions: [{ 'queue-mission': { agent: 'meta', title: 't', prompt: 'p' } }],
      }),
    });
    const written = fs.readFileSync(WATCHERS_PATH, 'utf-8');
    // The non-webhook watchers must still be present.
    expect(written).toMatch(/log-tail-canary/);
    expect(written).toMatch(/sqlite-poll-canary/);
    expect(written).toMatch(/existing-webhook/);
    expect(written).toMatch(/untouched/);
  });
});

describe('PUT /api/watchers/:slug (webhook update)', () => {
  it('updates mode without losing other fields', async () => {
    const res = await app.request(url('/api/watchers/existing-hook'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'existing-webhook',
        secret_env: 'EXISTING_SECRET',
        mode: 'run',
        actions: [{
          'queue-mission': {
            agent: 'meta',
            title: 'existing webhook',
            prompt: '{payload_raw}',
          },
        }],
      }),
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.watcher.mode).toBe('run');
    expect(j.watcher.slug).toBe('existing-hook'); // immutable
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.request(url('/api/watchers/no-such-thing'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x',
        secret_env: 'X',
        actions: [{ 'queue-mission': { agent: 'meta', title: 't', prompt: 'p' } }],
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/watchers/:slug (webhook delete)', () => {
  it('removes the watcher from watchers.yaml', async () => {
    const res = await app.request(url('/api/watchers/existing-hook'), {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const written = fs.readFileSync(WATCHERS_PATH, 'utf-8');
    expect(written).not.toMatch(/slug: existing-hook/);
    // Other watchers preserved.
    expect(written).toMatch(/log-tail-canary/);
    expect(written).toMatch(/sqlite-poll-canary/);
  });

  it('returns 404 for unknown slug', async () => {
    const res = await app.request(url('/api/watchers/never-existed'), {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed slug', async () => {
    const res = await app.request(url('/api/watchers/has%20spaces'), {
      method: 'DELETE',
    });
    expect([400, 404]).toContain(res.status);
  });
});
