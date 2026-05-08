import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Slice 10 Wave 0 — exercise the real readOrgChartV2() against a
// staged fixture tree. Same hoisted-tmpdir pattern as avatars.test.ts:
// we redirect PROJECT_ROOT and CLAUDECLAW_CONFIG via vi.mock so the
// reader walks the temp dir, not the real worktree.

const { TEST_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  return {
    TEST_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'org-chart-v2-test-')),
  };
});

vi.mock('./config.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  return {
    PROJECT_ROOT: TEST_ROOT,
    STORE_DIR: path.join(TEST_ROOT, 'store'),
    CLAUDECLAW_CONFIG: path.join(TEST_ROOT, 'config'),
    expandHome: (p: string) => p,
  };
});

const { readOrgChartV2 } = await import('./org-chart-v2.js');

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

describe('readOrgChartV2', () => {
  beforeEach(() => {
    // Wipe + re-create so each test stages its own fixture from scratch.
    fs.rmSync(path.join(TEST_ROOT, 'agents'), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_ROOT, 'humans.yaml'), { force: true });
    fs.mkdirSync(path.join(TEST_ROOT, 'agents'), { recursive: true });
  });

  it('returns a flat array with humans first, then AI agents — each carrying type + reports_to', () => {
    writeHumans(`humans:
  - id: joe
    name: Joe
    role: Founder
    type: "human"
    reports_to: ""
  - id: ali
    name: Ali
    role: Operator
    type: "human"
    reports_to: "joe"
`);

    // AI agent that reports to meta (an AI parent).
    writeAgent('content', `name: Content
description: "YouTube + LinkedIn content."
telegram_bot_token_env: CONTENT_BOT_TOKEN
lob: "course"
type: "ai"
reports_to: "meta"
`);
    // AI agent that reports to a human (joe). No reports_to override
    // would have defaulted to null — we want to verify the field round-trips.
    writeAgent('meta', `name: Meta
description: "Coordinator."
telegram_bot_token_env: META_BOT_TOKEN
lob: "personal"
type: "ai"
reports_to: "joe"
owns:
  scheduled_tasks:
    - "daily-rollup"
  triggered_tasks: []
  n8n_workflows: []
  watchers: []
`);
    // AI agent without reports_to set — should surface as null on the wire.
    writeAgent('orphan', `name: Orphan
description: "No parent yet."
telegram_bot_token_env: ORPHAN_BOT_TOKEN
lob: ""
type: "ai"
`);

    const nodes = readOrgChartV2();

    // Humans come first, then AI agents — order asserted by index.
    // Slice 10 Wave 4: synthesized `main` agent is always included so
    // count is +1 from the on-disk fixture (4 → 5 here).
    expect(nodes.length).toBe(6);
    expect(nodes[0].id).toBe('joe');
    expect(nodes[0].type).toBe('human');
    expect(nodes[1].id).toBe('ali');
    expect(nodes[1].type).toBe('human');
    for (const n of nodes.slice(2)) {
      expect(n.type).toBe('ai');
    }

    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    // Joe is root — empty-string reports_to becomes null on the wire.
    expect(byId.joe.reports_to).toBeNull();
    // Ali reports to Joe.
    expect(byId.ali.reports_to).toBe('joe');
    // Meta reports to a human (joe) — verifies cross-type edges work.
    expect(byId.meta.reports_to).toBe('joe');
    // Content reports to another AI (meta) — multi-tier tree.
    expect(byId.content.reports_to).toBe('meta');
    // Orphan with no reports_to in YAML surfaces as null.
    expect(byId.orphan.reports_to).toBeNull();

    // Spot-check the rest of the contract.
    expect(byId.meta.scheduled_count).toBe(1);
    expect(byId.meta.triggered_count).toBe(0);
    expect(byId.joe.lob).toBeNull();
    expect(byId.content.lob).toBe('course');
    // Humans have running:null / today_turns:null (no process to probe).
    expect(byId.joe.running).toBeNull();
    expect(byId.joe.today_turns).toBeNull();
  });

  it('always includes a synthesized `main` agent reporting to joe', () => {
    // Even with NO agent dirs on disk, main must surface so the org
    // chart shows the primary ClaudeClaw assistant alongside its peers.
    writeHumans(`humans:
  - id: joe
    name: Joe
    role: Founder
    type: "human"
    reports_to: ""
`);

    const nodes = readOrgChartV2();
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    expect(byId.main).toBeDefined();
    expect(byId.main.type).toBe('ai');
    expect(byId.main.name).toBe('Main');
    // Reports to joe so it sits as a sibling of meta on the chart.
    expect(byId.main.reports_to).toBe('joe');
    // Must carry the standard owns block (empty, but present so the
    // wire shape matches every other agent node).
    expect(byId.main.owns).toEqual({
      scheduled_tasks: [],
      triggered_tasks: [],
      n8n_workflows: [],
      watchers: [],
    });
    // Default running flag is false when no runtimeStats are passed.
    expect(byId.main.running).toBe(false);
  });

  it('does not duplicate `main` when an agents/main/agent.yaml exists on disk', () => {
    // Defensive: even if a future migration creates agents/main/agent.yaml,
    // the synthesized entry should still be the only `main` node.
    writeHumans(`humans:
  - id: joe
    name: Joe
    type: "human"
    reports_to: ""
`);
    writeAgent('main', `name: MainOnDisk
description: "Should be skipped — synthesized main wins."
telegram_bot_token_env: MAIN_BOT_TOKEN
type: "ai"
reports_to: "joe"
`);

    const nodes = readOrgChartV2();
    const mains = nodes.filter((n) => n.id === 'main');
    expect(mains).toHaveLength(1);
    // The synthesized entry is the canonical one — name "Main", not
    // "MainOnDisk" — proving listAgentIds()'s `main` was skipped.
    expect(mains[0].name).toBe('Main');
  });

  it('builds a parent-of map that lets a caller stitch the tree from reports_to edges', () => {
    writeHumans(`humans:
  - id: joe
    name: Joe
    role: Founder
    type: "human"
    reports_to: ""
`);
    writeAgent('meta', `name: Meta
description: "Lead."
telegram_bot_token_env: META_BOT_TOKEN
type: "ai"
reports_to: "joe"
`);
    writeAgent('comms', `name: Comms
description: "Inbox."
telegram_bot_token_env: COMMS_BOT_TOKEN
type: "ai"
reports_to: "meta"
`);

    const nodes = readOrgChartV2();
    const childrenOf = new Map<string, string[]>();
    for (const n of nodes) {
      const parent = n.reports_to ?? '__root__';
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(n.id);
    }

    // Joe is the only root.
    expect(childrenOf.get('__root__')).toEqual(['joe']);
    // Joe gets both meta (from disk) and the synthesized main agent.
    // Order matches insertion: synthesized main first, then disk-walked.
    expect(childrenOf.get('joe')?.sort()).toEqual(['main', 'meta']);
    // Comms is parented to meta.
    expect(childrenOf.get('meta')).toEqual(['comms']);
  });
});
