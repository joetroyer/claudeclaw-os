#!/usr/bin/env tsx
/**
 * Slice 10 Wave 0 — proof artifact builder.
 *
 * Drives the REAL `readOrgChartV2()` exported from src/org-chart-v2.ts
 * against a fixture tree, so the captured `api-org-chart-v2-sample.json`
 * is byte-faithful to what `/api/org-chart-v2` returns at runtime. No
 * re-implementation of the reader lives in this directory anymore.
 *
 * How the override works:
 *   - The reader resolves AI agent.yaml files via `resolveAgentDir()`
 *     in src/agent-config.ts, which checks `CLAUDECLAW_CONFIG/agents/<id>`
 *     first and falls back to `PROJECT_ROOT/agents/<id>`.
 *   - `listAgentIds()` scans both directories and dedupes.
 *   - `humansYamlPath()` (in src/org-chart-v2.ts) resolves to
 *     `PROJECT_ROOT/humans.yaml`.
 *
 * To stage a fixture without touching the worktree, we build a temp
 * dir laid out like a project root (humans.yaml + agents/<id>/agent.yaml),
 * then re-exec ourselves in a child process with:
 *   - CLAUDECLAW_CONFIG pointing at the fixture (so the agents come
 *     from there), and
 *   - PROJECT_ROOT effectively redirected by running the child with
 *     cwd = fixture, BUT since PROJECT_ROOT is resolved relative to
 *     src/config.ts at import time, cwd doesn't help.
 *
 * Solution: the child process imports the reader and the humans.yaml
 * resolver helper, then patches the resolver via a wrapper that reads
 * from the fixture root when CLAUDECLAW_FIXTURE_ROOT is set. The
 * cleanest way to do that without modifying production code is to
 * write the fixture's humans.yaml into the real PROJECT_ROOT/humans.yaml
 * IF AND ONLY IF the existing file is already byte-identical to the
 * fixture's planned content (so we never clobber Joe's data). For
 * proof purposes the fixture humans.yaml mirrors the worktree's
 * humans.yaml exactly, so this is a no-op write.
 *
 * Usage: tsx proof/slice-10/wave-0/build-fixture-and-sample.ts
 *
 * Writes:
 *   proof/slice-10/wave-0/fixture/             — the fixture tree
 *   proof/slice-10/wave-0/migration-fixture-output.txt — migrate-org-v2 output
 *   proof/slice-10/wave-0/api-org-chart-v2-sample.json — endpoint shape
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_ROOT = path.join(__dirname, 'fixture');
const FIXTURE_AGENTS = path.join(FIXTURE_ROOT, 'agents');

// Wipe + recreate the fixture root so re-runs are deterministic.
fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
fs.mkdirSync(FIXTURE_AGENTS, { recursive: true });

// ── humans.yaml ───────────────────────────────────────────────────────
// Mirror the worktree humans.yaml so the reader's PROJECT_ROOT-resolved
// humans list still lines up with the fixture's expected nodes.
fs.writeFileSync(
  path.join(FIXTURE_ROOT, 'humans.yaml'),
  `humans:
  - id: joe
    name: Joe
    role: Founder & Operator
    owns_lobs:
      - agency
      - goldbot
      - course
      - personal
    owns_projects: []
    type: "human"
    reports_to: ""

  - id: ali
    name: Ali
    role: Operator
    owns_lobs:
      - agency
    owns_projects: []
    type: "human"
    reports_to: "joe"
`,
  'utf-8',
);

// ── 8 AI agents — names + roles + ownership counts come from real
// agent.yaml shapes; tokens / secret env names are scrubbed since the
// fixture never runs as a real bot. ────────────────────────────────────

interface AgentSpec {
  id: string;
  name: string;
  description: string;
  lob: string;
  ownsScheduled?: string[];
  ownsTriggered?: string[];
  ownsWatchers?: string[];
  fourRsResults?: string[];
  skills?: string[];
}

const AGENTS: AgentSpec[] = [
  {
    id: 'meta',
    name: 'Meta',
    description: 'Coordinator. Splits work across the team, routes follow-ups, owns multi-agent orchestration.',
    lob: 'personal',
    ownsScheduled: ['daily-rollup', 'weekly-summary'],
  },
  {
    id: 'comms',
    name: 'Comms',
    description: 'All human communication — email, Slack, WhatsApp, YouTube comments, community forums, LinkedIn DMs.',
    lob: 'agency',
  },
  {
    id: 'content',
    name: 'Content',
    description: 'YouTube scripts, LinkedIn posts, carousels, trend research, content calendar.',
    lob: 'course',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Deep web research, academic sources, competitive intel, trend analysis.',
    lob: 'personal',
  },
  {
    id: 'ops',
    name: 'Ops',
    description: 'Calendar, scheduling, billing, Stripe, Gumroad, admin, task management.',
    lob: 'personal',
  },
  {
    id: 'clawds',
    name: 'Clawds',
    description: 'Google Ads expert. Reads CSV exports, screenshots, and account data; drafts ad copy, keyword strategies, campaign structures.',
    lob: 'agency',
  },
  {
    id: 'trading-monitor',
    name: 'Trading Monitor',
    description: 'Live signal handler. Receives trading signal webhooks (Gold Scalping, Ceddi, etc.), parses, classifies, logs.',
    lob: 'goldbot',
    ownsTriggered: ['trading-monitor-trigger'],
    ownsWatchers: ['trading-monitor-trigger'],
    fourRsResults: [
      'Triggered task acknowledged within 60s of webhook receipt',
      'Signal logged to hive_mind with provider, side, instrument, levels',
    ],
    skills: ['lab-query-signal-performance', 'lab-query-channel-credibility'],
  },
  {
    id: 'goldbot-labs',
    name: 'Gold Bot Labs',
    description: 'XAUUSD backtest & analysis agent — queries the lab DB, compares scenarios, surfaces what is working.',
    lob: 'goldbot',
  },
];

function agentYaml(spec: AgentSpec): string {
  const fourRs = (spec.fourRsResults ?? []).map((s) => `    - "${s.replace(/"/g, '\\"')}"`).join('\n');
  const ownsScheduled = (spec.ownsScheduled ?? []).map((s) => `    - "${s}"`).join('\n');
  const ownsTriggered = (spec.ownsTriggered ?? []).map((s) => `    - "${s}"`).join('\n');
  const ownsWatchers = (spec.ownsWatchers ?? []).map((s) => `    - "${s}"`).join('\n');
  const skills = (spec.skills ?? []).map((s) => `    - "${s}"`).join('\n');
  return `name: ${spec.name}
description: ${JSON.stringify(spec.description)}

# Token env name is scrubbed for the fixture — readOrgChartV2 doesn't read it.
telegram_bot_token_env: FIXTURE_BOT_TOKEN

model: claude-sonnet-4-6

four_rs:
  results:${fourRs ? '\n' + fourRs : ' []'}

owns:
  scheduled_tasks:${ownsScheduled ? '\n' + ownsScheduled : ' []'}
  triggered_tasks:${ownsTriggered ? '\n' + ownsTriggered : ' []'}
  n8n_workflows: []
  watchers:${ownsWatchers ? '\n' + ownsWatchers : ' []'}

lob: "${spec.lob}"

projects: []

ideal: false

platform: "claude"

skills:
  primary:${skills ? '\n' + skills : ' []'}

avatar: ""
`;
}

for (const spec of AGENTS) {
  const dir = path.join(FIXTURE_AGENTS, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), agentYaml(spec), 'utf-8');
}

// Run the migration against the fixture so it gets type + reports_to.
// The migration is idempotent and only touches files under <root>/agents
// and <root>/humans.yaml.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'migrate-org-v2.ts');
const out = execSync(
  `npx tsx ${JSON.stringify(scriptPath)} --root ${JSON.stringify(FIXTURE_ROOT)}`,
  { encoding: 'utf-8' },
);
fs.writeFileSync(path.join(__dirname, 'migration-fixture-output.txt'), out, 'utf-8');

// ── Drive the REAL reader against the fixture ────────────────────────
//
// The reader resolves PROJECT_ROOT (where humans.yaml lives) at import
// time relative to src/config.ts, so we cannot redirect it via an env
// var. Instead we re-exec ourselves with a small loader script that:
//   1. sets CLAUDECLAW_CONFIG=<fixture>          (agent dirs come from fixture)
//   2. monkey-patches `fs.readFileSync` for the single humans.yaml path
//      so it returns the fixture's humans.yaml without writing to the
//      real PROJECT_ROOT/humans.yaml on Joe's worktree.
//
// This guarantees the captured sample comes from the production reader,
// not a local re-implementation.

const loaderPath = path.join(__dirname, '.driver.mjs');
fs.writeFileSync(
  loaderPath,
  `import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const FIXTURE = process.env.CLAUDECLAW_FIXTURE_ROOT;
if (!FIXTURE) {
  process.stderr.write('CLAUDECLAW_FIXTURE_ROOT must be set\\n');
  process.exit(1);
}

// Redirect reads of PROJECT_ROOT/humans.yaml at the real worktree to
// the fixture's humans.yaml — without writing anything to the worktree.
const origReadFileSync = fs.readFileSync;
const fixtureHumans = path.join(FIXTURE, 'humans.yaml');
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const realHumans = path.join(repoRoot, 'humans.yaml');
fs.readFileSync = ((p, ...rest) => {
  if (typeof p === 'string' && path.resolve(p) === path.resolve(realHumans)) {
    return origReadFileSync(fixtureHumans, ...rest);
  }
  return origReadFileSync(p, ...rest);
});
const origExistsSync = fs.existsSync;
fs.existsSync = ((p) => {
  if (typeof p === 'string' && path.resolve(p) === path.resolve(realHumans)) {
    return origExistsSync(fixtureHumans);
  }
  return origExistsSync(p);
});

// Now import the real reader. ESM caches this module on first load so
// our fs patch applies to every subsequent call inside the reader.
const orgChart = await import('${path.join(repoRoot, 'src', 'org-chart-v2.ts').replace(/\\/g, '\\\\')}');
const agentConfig = await import('${path.join(repoRoot, 'src', 'agent-config.ts').replace(/\\/g, '\\\\')}');

// Demo runtime stats — same shape the dashboard route builds. Fixed
// values so the proof artifact is deterministic.
const demoStats = {
  meta: { running: true, today_turns: 8 },
  comms: { running: true, today_turns: 3 },
  content: { running: true, today_turns: 5 },
  research: { running: true, today_turns: 2 },
  ops: { running: true, today_turns: 1 },
  clawds: { running: true, today_turns: 0 },
  'trading-monitor': { running: true, today_turns: 12 },
  'goldbot-labs': { running: true, today_turns: 0 },
};
const runtime = new Map();
for (const id of agentConfig.listAgentIds()) {
  runtime.set(id, demoStats[id] ?? { running: true, today_turns: 0 });
}

const nodes = orgChart.readOrgChartV2(runtime);
process.stdout.write(JSON.stringify({ nodes }, null, 2) + '\\n');
`,
  'utf-8',
);

try {
  const childOut = execSync(
    `CLAUDECLAW_CONFIG=${JSON.stringify(FIXTURE_ROOT)} CLAUDECLAW_FIXTURE_ROOT=${JSON.stringify(FIXTURE_ROOT)} npx tsx ${JSON.stringify(loaderPath)}`,
    { encoding: 'utf-8' },
  );
  fs.writeFileSync(
    path.join(__dirname, 'api-org-chart-v2-sample.json'),
    childOut,
    'utf-8',
  );
} finally {
  fs.rmSync(loaderPath, { force: true });
}

console.log('Fixture built + endpoint sample captured at api-org-chart-v2-sample.json');
console.log(`Fixture root: ${FIXTURE_ROOT}`);
