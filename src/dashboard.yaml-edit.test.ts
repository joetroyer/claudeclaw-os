// Slice 10 Wave 3 — coverage for the four new YAML editor endpoints
// (`GET/PUT /api/agents/:id/yaml`, `GET/PUT /api/humans/:id/yaml`).
//
// We can't reuse the contract-test pattern directly because writing a
// real agent.yaml or humans.yaml under the live worktree would dirty the
// developer's checkout. Instead we redirect PROJECT_ROOT and
// CLAUDECLAW_CONFIG via vi.mock to a hoisted tmpdir, stage fresh fixtures
// per test, and exercise the real Hono app through `app.request()`. Same
// approach as src/org-chart-v2.test.ts.
//
// Auth: every route lives under /api/* so the dashboard's global auth
// middleware demands a `?token=` query string. We use the same test
// token process.env DASHBOARD_TOKEN was set to in src/test-env-setup.ts.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Hono } from 'hono';

const { TEST_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  return {
    TEST_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-yaml-edit-test-')),
  };
});

// Redirect PROJECT_ROOT before dashboard.ts evaluates so resolveAgentDir +
// humansYamlPath both look at the staged tmpdir. STORE_DIR points at the
// same tmpdir so any DB / pid-file probes are inert.
vi.mock('./config.js', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    PROJECT_ROOT: TEST_ROOT,
    STORE_DIR: path.join(TEST_ROOT, 'store'),
    CLAUDECLAW_CONFIG: path.join(TEST_ROOT, 'config'),
  };
});

const { _initTestDatabase } = await import('./db.js');
const { buildDashboardApp } = await import('./dashboard.js');

const TOKEN = process.env.DASHBOARD_TOKEN || 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function writeAgent(id: string, body: string): void {
  const dir = path.join(TEST_ROOT, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), body, 'utf-8');
}

function writeHumans(body: string): void {
  fs.writeFileSync(path.join(TEST_ROOT, 'humans.yaml'), body, 'utf-8');
}

function readAgent(id: string): string {
  return fs.readFileSync(path.join(TEST_ROOT, 'agents', id, 'agent.yaml'), 'utf-8');
}

function readHumansFile(): string {
  return fs.readFileSync(path.join(TEST_ROOT, 'humans.yaml'), 'utf-8');
}

const VALID_AGENT_YAML = `name: Meta
description: "Coordinator. Splits work across the team."
telegram_bot_token_env: META_BOT_TOKEN
type: "ai"
reports_to: "joe"
`;

const VALID_HUMANS_YAML = `humans:
  - id: joe
    name: Joe
    role: Founder / operator
    type: "human"
    reports_to: ""
  - id: ali
    name: Ali
    role: Operator
    type: "human"
    reports_to: "joe"
`;

beforeEach(() => {
  _initTestDatabase();
  fs.rmSync(path.join(TEST_ROOT, 'agents'), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_ROOT, 'humans.yaml'), { force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'agents'), { recursive: true });
  // Build the app fresh per test so any in-memory route singleton state
  // doesn't leak between cases. Hono's request() runs in-memory.
  app = buildDashboardApp(undefined) as unknown as Hono;
});

async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

// ────────────────────────────────────────────────────────────────────
// GET /api/agents/:id/yaml
// ────────────────────────────────────────────────────────────────────

describe('GET /api/agents/:id/yaml', () => {
  it('returns the raw yaml text for a known agent', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const res = await app.request('/api/agents/meta/yaml' + Q);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.yaml).toBe(VALID_AGENT_YAML);
  });

  it('returns 404 for an unknown agent id', async () => {
    const res = await app.request('/api/agents/no-such-agent/yaml' + Q);
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ error: expect.any(String) });
  });

  it('returns 400 for a syntactically invalid id', async () => {
    const res = await app.request('/api/agents/Bad..Id/yaml' + Q);
    expect(res.status).toBe(400);
  });

  it('returns 401 without a token', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const res = await app.request('/api/agents/meta/yaml');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────
// PUT /api/agents/:id/yaml
// ────────────────────────────────────────────────────────────────────

describe('PUT /api/agents/:id/yaml', () => {
  function put(id: string, payload: unknown) {
    return app.request('/api/agents/' + id + '/yaml' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('writes the new yaml and returns the updated node shape', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const next = `name: Meta v2
description: "Updated tagline."
telegram_bot_token_env: META_BOT_TOKEN
type: "ai"
reports_to: "joe"
`;
    const res = await put('meta', { yaml: next });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.node).toMatchObject({
      id: 'meta',
      type: 'ai',
      name: 'Meta v2',
    });
    expect(readAgent('meta')).toBe(next);
  });

  it('returns 400 for unparseable yaml', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const broken = "name: Meta\n\tdescription: tabs are illegal in indentation\n";
    const res = await put('meta', { yaml: broken });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/YAML parse error/i);
    expect(readAgent('meta')).toBe(VALID_AGENT_YAML);
  });

  it('returns 400 when the required name field is missing', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const next = `description: "Missing name field."
telegram_bot_token_env: META_BOT_TOKEN
`;
    const res = await put('meta', { yaml: next });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/name/);
    expect(readAgent('meta')).toBe(VALID_AGENT_YAML);
  });

  it('returns 400 when the required description field is missing', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const next = `name: Meta
telegram_bot_token_env: META_BOT_TOKEN
`;
    const res = await put('meta', { yaml: next });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/description/);
  });

  it('returns 400 when yaml exceeds 64KB', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const huge = 'name: A\ndescription: B\nfiller: "' + 'x'.repeat(70_000) + '"\n';
    const res = await put('meta', { yaml: huge });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing the yaml field', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const res = await put('meta', { content: VALID_AGENT_YAML });
    expect(res.status).toBe(400);
  });

  it('returns 401 without a token', async () => {
    writeAgent('meta', VALID_AGENT_YAML);
    const res = await app.request('/api/agents/meta/yaml', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: VALID_AGENT_YAML }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects path-traversal ids at the regex gate', async () => {
    const res = await app.request(
      '/api/agents/' + encodeURIComponent('../etc/passwd') + '/yaml' + Q,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml: VALID_AGENT_YAML }),
      },
    );
    expect([400, 404]).toContain(res.status);
    const escapeProbe = path.join(TEST_ROOT, '..', 'etc', 'passwd');
    expect(fs.existsSync(escapeProbe)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/humans/:id/yaml
// ────────────────────────────────────────────────────────────────────

describe('GET /api/humans/:id/yaml', () => {
  it('returns the matching human block as yaml', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await app.request('/api/humans/joe/yaml' + Q);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const parsed = yaml.load(body.yaml) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: 'joe',
      name: 'Joe',
      role: 'Founder / operator',
    });
  });

  it('returns 404 for an unknown human id', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await app.request('/api/humans/nobody/yaml' + Q);
    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await app.request('/api/humans/joe/yaml');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────
// PUT /api/humans/:id/yaml
// ────────────────────────────────────────────────────────────────────

describe('PUT /api/humans/:id/yaml', () => {
  function put(id: string, payload: unknown) {
    return app.request('/api/humans/' + id + '/yaml' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('replaces just the matching human block, leaves the rest intact', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const next = `id: joe
name: Joe Updated
role: Founder
type: "human"
reports_to: ""
`;
    const res = await put('joe', { yaml: next });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.node).toMatchObject({ id: 'joe', type: 'human', name: 'Joe Updated' });

    const onDisk = yaml.load(readHumansFile()) as { humans: Array<Record<string, unknown>> };
    const joe = onDisk.humans.find((h) => h.id === 'joe');
    const ali = onDisk.humans.find((h) => h.id === 'ali');
    expect(joe).toMatchObject({ name: 'Joe Updated' });
    expect(ali).toMatchObject({ name: 'Ali', role: 'Operator' });
  });

  it('returns 400 on unparseable yaml', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await put('joe', { yaml: "name: Joe\n\trole: bad-tab\n" });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await put('joe', { yaml: 'role: Founder\n' });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/name/);
  });

  it('returns 400 when neither role nor description is present', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await put('joe', { yaml: 'name: Joe\n' });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/role|description/);
  });

  it('returns 404 when the human id does not exist in the file', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await put('nobody', {
      yaml: 'name: Nobody\nrole: Filler\n',
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await app.request('/api/humans/joe/yaml', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: 'name: Joe\nrole: Founder\n' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects path-traversal ids', async () => {
    writeHumans(VALID_HUMANS_YAML);
    const res = await app.request(
      '/api/humans/' + encodeURIComponent('../passwd') + '/yaml' + Q,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml: 'name: Joe\nrole: Founder\n' }),
      },
    );
    expect([400, 404]).toContain(res.status);
  });

  // The reviewer flagged "the PUT rewrites the entire humans.yaml file"
  // as a violation of the block-only contract. The endpoint comment in
  // src/dashboard.ts spells out that the contract is "block-only by
  // VALUE, not by byte-range" — every field of every untouched human
  // must survive the round-trip exactly. This test pins that down.
  it('preserves every other humans entry by value when one is updated', async () => {
    const richYaml = `humans:
  - id: joe
    name: Joe
    role: Founder / operator
    type: "human"
    reports_to: ""
    email: joe@example.com
    avatar: /static/joe.png
    slack_id: U01JOE
    tz: America/New_York
  - id: ali
    name: Ali
    role: Operator
    type: "human"
    reports_to: "joe"
    email: ali@example.com
    avatar: /static/ali.png
    slack_id: U02ALI
    tz: Europe/London
  - id: sam
    name: Sam
    role: Advisor
    type: "human"
    reports_to: "joe"
    email: sam@example.com
    avatar: /static/sam.png
    slack_id: U03SAM
    tz: Asia/Tokyo
`;
    writeHumans(richYaml);
    const before = yaml.load(readHumansFile()) as { humans: Array<Record<string, unknown>> };
    const aliBefore = before.humans.find((h) => h.id === 'ali');
    const samBefore = before.humans.find((h) => h.id === 'sam');

    const next = `id: joe
name: Joe Renamed
role: Founder
type: "human"
reports_to: ""
email: joe-new@example.com
`;
    const res = await put('joe', { yaml: next });
    expect(res.status).toBe(200);

    const after = yaml.load(readHumansFile()) as { humans: Array<Record<string, unknown>> };
    const aliAfter = after.humans.find((h) => h.id === 'ali');
    const samAfter = after.humans.find((h) => h.id === 'sam');

    // Block-only by VALUE: every field on every untouched entry must
    // round-trip exactly. Deep-equal — not subset-match — so an
    // accidentally dropped key (e.g. `tz` lost during serialization)
    // would fail this assertion.
    expect(aliAfter).toEqual(aliBefore);
    expect(samAfter).toEqual(samBefore);

    // And the targeted entry took the new values.
    const joeAfter = after.humans.find((h) => h.id === 'joe');
    expect(joeAfter).toMatchObject({
      id: 'joe',
      name: 'Joe Renamed',
      role: 'Founder',
      email: 'joe-new@example.com',
    });
  });
});
