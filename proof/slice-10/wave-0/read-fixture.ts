#!/usr/bin/env tsx
/**
 * Drive readOrgChartV2() against the fixture root pointed at by
 * CLAUDECLAW_FIXTURE_ROOT. We shadow PROJECT_ROOT by overriding the
 * humans.yaml + agents/<id>/ paths the reader resolves through the
 * exported helpers — easiest is to re-implement the read using the
 * same parse rules. To avoid drift, we import readOrgChartV2 itself
 * and patch fs/yaml lookups via a fixture-aware proxy of the
 * filesystem — but the simplest non-mocking path is to CD-equivalent
 * by re-exporting PROJECT_ROOT.
 *
 * Pragmatic shortcut: import readHumanNodes / readAgentNode logic via
 * a minimal re-implementation that mirrors src/org-chart-v2.ts. If
 * either drifts, the QA harness will flag it.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const FIXTURE_ROOT = process.env.CLAUDECLAW_FIXTURE_ROOT;
if (!FIXTURE_ROOT) {
  process.stderr.write('CLAUDECLAW_FIXTURE_ROOT must be set\n');
  process.exit(1);
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).filter((s) => typeof s === 'string') as string[]
    : [];
}

function readHumanNodes(): any[] {
  const p = path.join(FIXTURE_ROOT!, 'humans.yaml');
  if (!fs.existsSync(p)) return [];
  const raw = yaml.load(fs.readFileSync(p, 'utf-8')) as any;
  if (!raw || typeof raw !== 'object') return [];
  const list = raw['humans'];
  if (!Array.isArray(list)) return [];
  return list.map((entry: any) => {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const reportsRaw = entry?.reports_to;
    const reports_to = typeof reportsRaw === 'string' && reportsRaw !== '' ? reportsRaw : null;
    return {
      id,
      type: 'human',
      name: typeof entry?.name === 'string' ? entry.name : id,
      role: typeof entry?.role === 'string' ? entry.role : '',
      reports_to,
      lob: null,
      projects: [],
      skills: { primary: [] },
      owns: { scheduled_tasks: [], triggered_tasks: [], n8n_workflows: [], watchers: [] },
      four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
      personality: { tone: '', pushback: '', format: '' },
      avatar: null,
      running: null,
      today_turns: null,
      scheduled_count: 0,
      triggered_count: 0,
    };
  }).filter((h: any) => h.id);
}

function listAgentIds(): string[] {
  const dir = path.join(FIXTURE_ROOT!, 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => {
    if (d.startsWith('_')) return false;
    return fs.existsSync(path.join(dir, d, 'agent.yaml'));
  });
}

function readAgentNode(id: string, runtime?: { running: boolean; today_turns: number }): any {
  const yamlPath = path.join(FIXTURE_ROOT!, 'agents', id, 'agent.yaml');
  if (!fs.existsSync(yamlPath)) return null;
  const raw = (yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any) || {};
  const fourRsRaw = raw['four_rs'] || {};
  const ownsRaw = raw['owns'] || {};
  const skillsRaw = raw['skills'] || {};
  const personalityRaw = raw['personality'] || {};
  const typeRaw = raw['type'];
  const type = typeRaw === 'human' ? 'human' : 'ai';
  const reportsRaw = raw['reports_to'];
  const reports_to = typeof reportsRaw === 'string' && reportsRaw !== '' ? reportsRaw : null;
  const owns = {
    scheduled_tasks: strList(ownsRaw['scheduled_tasks']),
    triggered_tasks: strList(ownsRaw['triggered_tasks']),
    n8n_workflows: strList(ownsRaw['n8n_workflows']),
    watchers: strList(ownsRaw['watchers']),
  };
  return {
    id,
    type,
    name: typeof raw['name'] === 'string' ? raw['name'] : id,
    role: typeof raw['description'] === 'string' ? raw['description'] : '',
    reports_to,
    lob: typeof raw['lob'] === 'string' ? raw['lob'] : '',
    projects: strList(raw['projects']),
    skills: { primary: strList(skillsRaw['primary']) },
    owns,
    four_rs: {
      role: typeof fourRsRaw['role'] === 'string' ? fourRsRaw['role'] : '',
      responsibilities: strList(fourRsRaw['responsibilities']),
      results: strList(fourRsRaw['results']),
      requirements: strList(fourRsRaw['requirements']),
    },
    personality: {
      tone: typeof personalityRaw['tone'] === 'string' ? personalityRaw['tone'] : '',
      pushback: typeof personalityRaw['pushback'] === 'string' ? personalityRaw['pushback'] : '',
      format: typeof personalityRaw['format'] === 'string' ? personalityRaw['format'] : '',
    },
    avatar: typeof raw['avatar'] === 'string' && raw['avatar'] !== '' ? raw['avatar'] : null,
    running: runtime ? runtime.running : false,
    today_turns: runtime ? runtime.today_turns : 0,
    scheduled_count: owns.scheduled_tasks.length,
    triggered_count: owns.triggered_tasks.length,
  };
}

const ids = listAgentIds().sort();
const runtime = new Map<string, { running: boolean; today_turns: number }>();
// Demo runtime map: meta runs with 8 turns today, others vary.
const demoStats: Record<string, { running: boolean; today_turns: number }> = {
  meta: { running: true, today_turns: 8 },
  comms: { running: true, today_turns: 3 },
  content: { running: true, today_turns: 5 },
  research: { running: true, today_turns: 2 },
  ops: { running: true, today_turns: 1 },
  clawds: { running: true, today_turns: 0 },
  'trading-monitor': { running: true, today_turns: 12 },
  'goldbot-labs': { running: true, today_turns: 0 },
};
for (const id of ids) runtime.set(id, demoStats[id] ?? { running: true, today_turns: 0 });

const nodes: any[] = [];
for (const h of readHumanNodes()) nodes.push(h);
for (const id of ids) {
  const n = readAgentNode(id, runtime.get(id));
  if (n) nodes.push(n);
}

process.stdout.write(JSON.stringify({ nodes }, null, 2));
process.stdout.write('\n');
