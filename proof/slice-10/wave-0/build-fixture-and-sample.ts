#!/usr/bin/env tsx
/**
 * Build a fixture mirror of the production agents/ tree (all 8 AI
 * agents + humans.yaml), apply migrate-org-v2.ts, then drive the
 * readOrgChartV2() reader against the fixture so we can capture an
 * end-to-end sample of the /api/org-chart-v2 payload — without
 * touching any live agent.yaml on Joe's box.
 *
 * Usage: tsx proof/slice-10/wave-0/build-fixture-and-sample.ts
 *
 * Writes:
 *   proof/slice-10/wave-0/fixture/...        — the fixture tree
 *   proof/slice-10/wave-0/api-org-chart-v2-sample.json — endpoint shape
 *
 * The fixture's agent.yaml files are stripped of bot tokens and any
 * other secret metadata — all we need are the schema fields the
 * org-chart-v2 reader cares about.
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

  - id: ali
    name: Ali
    role: Operator
    owns_lobs:
      - agency
    owns_projects: []
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
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'migrate-org-v2.ts');
const out = execSync(
  `npx tsx ${JSON.stringify(scriptPath)} --root ${JSON.stringify(FIXTURE_ROOT)}`,
  { encoding: 'utf-8' },
);
fs.writeFileSync(path.join(__dirname, 'migration-fixture-output.txt'), out, 'utf-8');

// Now drive the reader against the fixture — we set CLAUDECLAW_CONFIG
// AND inline-shadow PROJECT_ROOT by importing org-chart-v2 fresh under
// a node child process with the env override pointing at fixture/.
//
// Easiest: spawn a tiny node script that imports the compiled module
// after rewriting PROJECT_ROOT. Even easier: replicate the reader's
// logic here against the fixture YAMLs, since the reader is small and
// the fixture owns its file layout. We use the SAME parse rules as
// readOrgChartV2 in src/org-chart-v2.ts, so any drift would surface as
// a shape mismatch in REVIEW.
//
// We import the real reader by setting CLAUDECLAW_CONFIG=<fixture> AND
// running in a sub-process where PROJECT_ROOT in the imported module
// points at the fixture. Achieved via the env var
// CLAUDECLAW_FIXTURE_ROOT — see read-fixture.ts.

const childOut = execSync(
  `CLAUDECLAW_FIXTURE_ROOT=${JSON.stringify(FIXTURE_ROOT)} npx tsx ${JSON.stringify(path.join(__dirname, 'read-fixture.ts'))}`,
  { encoding: 'utf-8' },
);
fs.writeFileSync(
  path.join(__dirname, 'api-org-chart-v2-sample.json'),
  childOut,
  'utf-8',
);

console.log('Fixture built + endpoint sample captured at api-org-chart-v2-sample.json');
console.log(`Fixture root: ${FIXTURE_ROOT}`);
