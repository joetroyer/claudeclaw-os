// Slice 4 — n8n auto-task routing contract test.
//
// Exercises:
//   - lookupN8nWorkflowOwner returns the registered owner / null
//   - runActions handles `lookup-owner` (sets owner gate vars + debounce)
//   - `if-owned` runs nested actions only when an owner was found
//   - `if-unowned` runs nested actions only when no owner was found
//   - debounce by workflow_id + error_signature: same pair within 60s
//     fires once
//   - `send-slack` posts to the configured webhook URL (mocked fetch)
//   - End-to-end: POST /api/watchers/webhook/n8n-error with a valid HMAC
//     creates the right mission_task(s) and (for unowned) attempts a
//     Slack post.
//
// Test-DB strategy: the watcher action runner (`runActions`) opens its
// own better-sqlite3 connection for queue-mission writes, so we share an
// on-disk tmp file between the test's shared db handle (`_initTestDatabaseAtPath`)
// and the watcher's per-call connection (`storeDbPath()` reads
// CLAUDECLAW_STORE_DB_PATH). Both land in the same physical file so
// reads see writes.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Set the override BEFORE importing modules that read it at load time.
const TMP_DB = path.join(os.tmpdir(), `slice4-n8n-${process.pid}-${Date.now()}.db`);
process.env.CLAUDECLAW_STORE_DB_PATH = TMP_DB;
process.env.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';

import {
  _initTestDatabaseAtPath,
  upsertN8nWorkflowOwner,
  lookupN8nWorkflowOwner,
  listN8nWorkflowOwners,
  deleteN8nWorkflowOwner,
  getMissionTask,
} from './db.js';
import { runActions, _resetN8nDebounceForTests } from './watchers.js';
import type { Action } from './watchers.js';

// Mock the watcher loader for the dashboard end-to-end tests below. We
// use the SAME action shape as watchers.yaml so the contract guards
// against drift between the YAML and the runtime.
const N8N_ROUTER_ACTIONS: Action[] = [
  { 'lookup-owner': { workflow_field: 'workflow_id', signature_field: 'error_signature', debounce_sec: 60 } },
  {
    'if-owned': [
      {
        'queue-mission': {
          agent: '{_owner_agent}',
          title: 'n8n error: {payload.workflow_name} ({_workflow_id})',
          prompt: 'Workflow {payload.workflow_name} ({_workflow_id}) errored: {payload.error_message}',
        },
      },
    ],
  },
  {
    'if-unowned': [
      {
        'queue-mission': {
          agent: 'meta',
          title: 'n8n triage: unowned workflow {_workflow_id}',
          prompt: 'Unowned n8n workflow {payload.workflow_name} errored: {payload.error_message}',
        },
      },
      {
        'send-slack': {
          webhook_url_env: 'SLACK_WEBHOOK_URL',
          template: 'Unowned n8n workflow {_workflow_id} errored. Triage at /mission',
        },
      },
    ],
  },
];

// Mock only the loader — we want the REAL runActions so we can test it.
vi.mock('./watchers.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    loadWebhookWatcher: (slug: string) => {
      if (slug === 'n8n-error') {
        return {
          name: 'n8n-error-router',
          type: 'webhook',
          slug: 'n8n-error',
          secret_env: 'N8N_ERROR_SECRET',
          mode: 'run',
          actions: N8N_ROUTER_ACTIONS,
        };
      }
      return null;
    },
    listWebhookWatchers: () => [
      {
        name: 'n8n-error-router',
        type: 'webhook',
        slug: 'n8n-error',
        secret_env: 'N8N_ERROR_SECRET',
        mode: 'run',
        actions: N8N_ROUTER_ACTIONS,
      },
    ],
  };
});

import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

let app: Hono;
const TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  // Fresh on-disk DB per test so the shared handle and the per-call
  // queue-mission connections see the same state without bleed.
  try { fs.unlinkSync(TMP_DB); } catch { /* first run */ }
  _initTestDatabaseAtPath(TMP_DB);
  _resetN8nDebounceForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  try { fs.unlinkSync(TMP_DB); } catch { /* tmp cleanup best-effort */ }
});

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('Slice 4 — lookupN8nWorkflowOwner', () => {
  it('returns null for an unknown workflow_id', () => {
    expect(lookupN8nWorkflowOwner('does-not-exist')).toBeNull();
  });

  it('returns the registered agent_id for a known workflow_id', () => {
    upsertN8nWorkflowOwner('wf_lab_etl_42', 'goldbot-labs');
    expect(lookupN8nWorkflowOwner('wf_lab_etl_42')).toBe('goldbot-labs');
  });

  it('upsert overwrites the existing owner', () => {
    upsertN8nWorkflowOwner('wf_x', 'research');
    upsertN8nWorkflowOwner('wf_x', 'ops');
    expect(lookupN8nWorkflowOwner('wf_x')).toBe('ops');
  });

  it('returns null for empty workflow_id', () => {
    expect(lookupN8nWorkflowOwner('')).toBeNull();
  });

  it('listN8nWorkflowOwners returns rows in workflow_id order', () => {
    upsertN8nWorkflowOwner('wf_b', 'ops');
    upsertN8nWorkflowOwner('wf_a', 'research');
    const rows = listN8nWorkflowOwners();
    expect(rows.map((r) => r.workflow_id)).toEqual(['wf_a', 'wf_b']);
  });

  it('deleteN8nWorkflowOwner removes a row', () => {
    upsertN8nWorkflowOwner('wf_z', 'meta');
    deleteN8nWorkflowOwner('wf_z');
    expect(lookupN8nWorkflowOwner('wf_z')).toBeNull();
  });

  it('upsertN8nWorkflowOwner rejects empty inputs', () => {
    expect(() => upsertN8nWorkflowOwner('', 'meta')).toThrow();
    expect(() => upsertN8nWorkflowOwner('wf_x', '')).toThrow();
  });
});

describe('Slice 4 — runActions n8n routing', () => {
  it('if-owned fires nested action when owner is registered', async () => {
    upsertN8nWorkflowOwner('wf_owned_1', 'research');
    const ids = await runActions(N8N_ROUTER_ACTIONS, {
      watcher: 'n8n-error-router',
      slug: 'n8n-error',
      mode: 'run',
      payload: {
        workflow_id: 'wf_owned_1',
        workflow_name: 'Lab ETL',
        error_message: 'connection refused on broker api',
      },
      payload_raw: '{"workflow_id":"wf_owned_1"}',
    });
    expect(ids.length).toBe(1); // exactly 1 mission queued
    const task = getMissionTask(ids[0]);
    expect(task?.assigned_agent).toBe('research');
    expect(task?.title).toContain('Lab ETL');
    expect(task?.title).toContain('wf_owned_1');
  });

  it('if-unowned fires nested actions when owner is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true, status: 200, text: async () => 'ok',
    } as never);
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/X/Y/Z';

    const ids = await runActions(N8N_ROUTER_ACTIONS, {
      watcher: 'n8n-error-router',
      slug: 'n8n-error',
      mode: 'run',
      payload: {
        workflow_id: 'wf_unowned_99',
        workflow_name: 'Unknown Flow',
        error_message: 'oops',
      },
      payload_raw: '{"workflow_id":"wf_unowned_99"}',
    });
    expect(ids.length).toBe(1);
    const task = getMissionTask(ids[0]);
    expect(task?.assigned_agent).toBe('meta');
    expect(task?.title).toContain('unowned');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = fetchSpy.mock.calls[0][0];
    expect(callUrl).toBe('https://hooks.slack.example/services/X/Y/Z');
  });

  it('debounces same workflow_id + error_signature within 60s', async () => {
    upsertN8nWorkflowOwner('wf_dup', 'ops');
    const vars = {
      watcher: 'n8n-error-router',
      slug: 'n8n-error',
      mode: 'run',
      payload: {
        workflow_id: 'wf_dup',
        workflow_name: 'Dup Flow',
        error_message: 'same error message',
        error_signature: 'fp_42',
      },
      payload_raw: '{"workflow_id":"wf_dup"}',
    };
    const first = await runActions(N8N_ROUTER_ACTIONS, { ...vars });
    const second = await runActions(N8N_ROUTER_ACTIONS, { ...vars });
    expect(first.length).toBe(1);
    expect(second.length).toBe(0); // debounced
  });

  it('debounce uses fingerprint of error_message when no signature field', async () => {
    upsertN8nWorkflowOwner('wf_hash', 'ops');
    const v1 = {
      watcher: 'n8n-error-router', slug: 'n8n-error', mode: 'run',
      payload: { workflow_id: 'wf_hash', error_message: 'connection refused' },
      payload_raw: '',
    };
    const v2 = {
      watcher: 'n8n-error-router', slug: 'n8n-error', mode: 'run',
      payload: { workflow_id: 'wf_hash', error_message: 'connection refused' },
      payload_raw: '',
    };
    const v3 = {
      watcher: 'n8n-error-router', slug: 'n8n-error', mode: 'run',
      payload: { workflow_id: 'wf_hash', error_message: 'totally different error' },
      payload_raw: '',
    };
    expect((await runActions(N8N_ROUTER_ACTIONS, v1)).length).toBe(1);
    expect((await runActions(N8N_ROUTER_ACTIONS, v2)).length).toBe(0); // debounced
    expect((await runActions(N8N_ROUTER_ACTIONS, v3)).length).toBe(1); // new sig → fires
  });

  it('different workflow_ids do not share debounce state', async () => {
    upsertN8nWorkflowOwner('wf_a', 'ops');
    upsertN8nWorkflowOwner('wf_b', 'ops');
    const a1 = await runActions(N8N_ROUTER_ACTIONS, {
      payload: { workflow_id: 'wf_a', error_message: 'boom', error_signature: 's' },
      payload_raw: '',
    });
    const b1 = await runActions(N8N_ROUTER_ACTIONS, {
      payload: { workflow_id: 'wf_b', error_message: 'boom', error_signature: 's' },
      payload_raw: '',
    });
    expect(a1.length).toBe(1);
    expect(b1.length).toBe(1);
  });

  it('if-owned defaults closed when no lookup-owner ran first', async () => {
    const orphan: Action[] = [
      {
        'if-owned': [
          { 'queue-mission': { agent: 'meta', title: 'should not fire', prompt: '' } },
        ],
      },
    ];
    const ids = await runActions(orphan, { payload: {}, payload_raw: '' });
    expect(ids).toEqual([]);
  });

  it('send-slack with no SLACK_WEBHOOK_URL env is a no-op (does not throw)', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const actions: Action[] = [
      { 'send-slack': { template: 'hi {payload.x}' } },
    ];
    const ids = await runActions(actions, { payload: { x: 1 }, payload_raw: '' });
    expect(ids).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Slice 4 — end-to-end via /api/watchers/webhook/n8n-error', () => {
  it('owned workflow → mission_task on the owning agent', async () => {
    process.env.N8N_ERROR_SECRET = 'n8n-secret';
    upsertN8nWorkflowOwner('wf_owned_e2e', 'research');

    const body = JSON.stringify({
      workflow_id: 'wf_owned_e2e',
      workflow_name: 'Lab ETL',
      error_message: 'broker api 500',
      error_signature: 'fp_abc',
      execution_url: 'https://n8n.example/exec/123',
    });
    const sig = sign('n8n-secret', body);
    const res = await app.request('/api/watchers/webhook/n8n-error', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-claudeclaw-signature': 'sha256=' + sig },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; queued_mission_tasks: string[] };
    expect(j.ok).toBe(true);
    expect(j.queued_mission_tasks.length).toBe(1);
    const task = getMissionTask(j.queued_mission_tasks[0]);
    expect(task?.assigned_agent).toBe('research');
  });

  it('unowned workflow → mission_task on meta + Slack post', async () => {
    process.env.N8N_ERROR_SECRET = 'n8n-secret';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/X/Y/Z';
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true, status: 200, text: async () => 'ok',
    } as never);

    const body = JSON.stringify({
      workflow_id: 'wf_unowned_e2e',
      workflow_name: 'Mystery Flow',
      error_message: 'something blew up',
      error_signature: 'fp_xyz',
    });
    const sig = sign('n8n-secret', body);
    const res = await app.request('/api/watchers/webhook/n8n-error', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-claudeclaw-signature': 'sha256=' + sig },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; queued_mission_tasks: string[] };
    expect(j.queued_mission_tasks.length).toBe(1);
    const task = getMissionTask(j.queued_mission_tasks[0]);
    expect(task?.assigned_agent).toBe('meta');
    expect(task?.title).toContain('unowned');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('same n8n error fired twice → exactly one mission_task (debounce)', async () => {
    process.env.N8N_ERROR_SECRET = 'n8n-secret';
    upsertN8nWorkflowOwner('wf_double', 'ops');

    const body = JSON.stringify({
      workflow_id: 'wf_double',
      workflow_name: 'Dup Flow',
      error_message: 'same error',
      error_signature: 'fp_dup',
    });
    const sig = sign('n8n-secret', body);
    const opts = {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-claudeclaw-signature': 'sha256=' + sig },
    };
    const r1 = await app.request('/api/watchers/webhook/n8n-error', opts);
    const r2 = await app.request('/api/watchers/webhook/n8n-error', opts);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = (await r1.json()) as { queued_mission_tasks: string[] };
    const j2 = (await r2.json()) as { queued_mission_tasks: string[] };
    expect(j1.queued_mission_tasks.length).toBe(1);
    expect(j2.queued_mission_tasks.length).toBe(0); // debounced
  });

  it('unsigned POST is rejected with 401 (HMAC inherited from Slice 2)', async () => {
    process.env.N8N_ERROR_SECRET = 'n8n-secret';
    const res = await app.request('/api/watchers/webhook/n8n-error', {
      method: 'POST',
      body: JSON.stringify({ workflow_id: 'wf_x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('mis-signed POST is rejected with 401 (HMAC inherited from Slice 2)', async () => {
    process.env.N8N_ERROR_SECRET = 'n8n-secret';
    const body = JSON.stringify({ workflow_id: 'wf_y' });
    const wrongSig = sign('not-the-secret', body);
    const res = await app.request('/api/watchers/webhook/n8n-error', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-claudeclaw-signature': 'sha256=' + wrongSig },
    });
    expect(res.status).toBe(401);
  });
});

// Reference TOKEN to avoid unused warning if any test references it.
void TOKEN;
