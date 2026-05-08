// Coverage for GET /api/skills — the slash-menu discovery endpoint that
// the War Room text mode fetches at page load to enrich its slash popup.
//
// Asserts:
//   - The endpoint is gated by the standard token middleware (401 without).
//   - With a valid token it always returns 200 + { skills: [...] } even
//     when the registry is uninitialized (hot-reload safety net).
//   - When the registry is populated from a tmpdir with one project +
//     one global skill, both surface with their respective `source` tag.
//
// Tests use Hono's app.request() so no real port is opened.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import { initSkillRegistry, getAllSkills } from './skill-registry.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
});

function writeSkill(baseDir: string, slug: string, content: string): void {
  const dir = path.join(baseDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

describe('GET /api/skills', () => {
  it('rejects requests without a token (401)', async () => {
    const res = await app.request('/api/skills');
    expect(res.status).toBe(401);
  });

  it('returns { skills: [] } when registry is uninitialized', async () => {
    // Force a clean (empty) registry — initSkillRegistry against a tmpdir
    // with no skills/ subdir produces an empty map.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-endpoint-empty-'));
    fs.writeFileSync(path.join(tempRoot, 'CLAUDE.md'), '# test');
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-endpoint-home-'));
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      initSkillRegistry(tempRoot);
      expect(getAllSkills()).toHaveLength(0);

      const res = await app.request('/api/skills' + Q);
      expect(res.status).toBe(200);
      const body = await res.json() as { skills: unknown[] };
      expect(body).toMatchObject({ skills: expect.any(Array) });
      expect(body.skills).toHaveLength(0);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('surfaces project + global skills with source tags', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-endpoint-pop-'));
    fs.writeFileSync(path.join(tempRoot, 'CLAUDE.md'), '# test');
    fs.mkdirSync(path.join(tempRoot, 'skills'), { recursive: true });

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-endpoint-home-'));
    fs.mkdirSync(path.join(tempHome, '.claude', 'skills'), { recursive: true });

    const origHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      writeSkill(
        path.join(tempRoot, 'skills'),
        'project-only',
        `---\nname: Project Only\ndescription: Lives in the project skills dir\ntriggers: project\n---\n# Project Only\n`,
      );
      writeSkill(
        path.join(tempHome, '.claude', 'skills'),
        'global-only',
        `---\nname: Global Only\ndescription: Lives in ~/.claude/skills\ntriggers: global\n---\n# Global Only\n`,
      );

      initSkillRegistry(tempRoot);
      // Sanity: registry actually picked them both up.
      const all = getAllSkills();
      expect(all.find((s) => s.id === 'project-only')?.source).toBe('project');
      expect(all.find((s) => s.id === 'global-only')?.source).toBe('global');

      const res = await app.request('/api/skills' + Q);
      expect(res.status).toBe(200);
      const body = await res.json() as { skills: Array<{ id: string; source: string; description: string; name: string }> };
      const ids = body.skills.map((s) => s.id);
      expect(ids).toContain('project-only');
      expect(ids).toContain('global-only');
      const proj = body.skills.find((s) => s.id === 'project-only')!;
      const glob = body.skills.find((s) => s.id === 'global-only')!;
      expect(proj.source).toBe('project');
      expect(glob.source).toBe('global');
      expect(proj.description.length).toBeLessThanOrEqual(120);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('truncates description to 120 chars', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-endpoint-trunc-'));
    fs.writeFileSync(path.join(tempRoot, 'CLAUDE.md'), '# test');
    fs.mkdirSync(path.join(tempRoot, 'skills'), { recursive: true });
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-endpoint-home-'));
    fs.mkdirSync(path.join(tempHome, '.claude', 'skills'), { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const longDesc = 'x'.repeat(500);
      writeSkill(
        path.join(tempRoot, 'skills'),
        'wordy',
        `---\nname: Wordy\ndescription: ${longDesc}\n---\n# Wordy\n`,
      );
      initSkillRegistry(tempRoot);

      const res = await app.request('/api/skills' + Q);
      const body = await res.json() as { skills: Array<{ id: string; description: string }> };
      const wordy = body.skills.find((s) => s.id === 'wordy')!;
      expect(wordy).toBeDefined();
      expect(wordy.description.length).toBe(120);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
