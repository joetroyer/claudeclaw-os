/**
 * Slice 10 Wave 0 — Org Chart V2 (read-only).
 *
 * Pure consumers of:
 *   - humans.yaml            — humans + their `type` / `reports_to`
 *   - agents/<id>/agent.yaml — Slice-1 metadata + the new Slice-10 fields
 *                              `type` ("ai") and `reports_to`
 *
 * Returns a flat array of nodes — humans + AI agents in the same shape —
 * with `reports_to` edges so the client can assemble the tree.
 *
 * This module is intentionally separate from `src/org-chart.ts` so the
 * Slice 3 endpoints (`/api/org-chart/*`) keep their original response
 * shape. Slice 10 builds the new `/api/org-chart-v2` endpoint and the
 * coming `/org-chart-v2` page on top of this module.
 *
 * NEVER writes anything. The dashboard exposes this via a single GET
 * endpoint under /api/org-chart-v2.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { PROJECT_ROOT } from './config.js';
import { listAgentIds, resolveAgentDir } from './agent-config.js';

// ── types ────────────────────────────────────────────────────────────

export interface OrgV2OwnsBlock {
  scheduled_tasks: string[];
  triggered_tasks: string[];
  n8n_workflows: string[];
  watchers: string[];
}

export interface OrgV2FourRs {
  /** Slice 1 surface. role / responsibilities / requirements live in
   *  CLAUDE.md as prose, so they're returned as empty defaults here for
   *  shape stability. The OrgChartV2 UI may stitch them in later from a
   *  separate persona endpoint. */
  role: string;
  responsibilities: string[];
  results: string[];
  requirements: string[];
}

export interface OrgV2Personality {
  /** Same story as four_rs — these live in CLAUDE.md prose, not YAML. */
  tone: string;
  pushback: string;
  format: string;
}

export interface OrgV2Skills {
  primary: string[];
}

export interface OrgV2Node {
  id: string;
  type: 'ai' | 'human';
  name: string;
  role: string;
  /** Parent node id (agent or human). `null` ⇒ root. Joe should be the
   *  only `null` in production. */
  reports_to: string | null;
  /** Slice-1 line-of-business. `null` for humans. */
  lob: string | null;
  projects: string[];
  skills: OrgV2Skills;
  owns: OrgV2OwnsBlock;
  four_rs: OrgV2FourRs;
  personality: OrgV2Personality;
  /** Avatar path/URL. Slice 7 populates these for AI agents; humans get
   *  `null` for now. */
  avatar: string | null;
  /** Live runtime fields. `null` for humans (no process). */
  running: boolean | null;
  today_turns: number | null;
  scheduled_count: number;
  triggered_count: number;
}

// ── path helpers ─────────────────────────────────────────────────────

function humansYamlPath(): string {
  return path.join(PROJECT_ROOT, 'humans.yaml');
}

// ── parsing helpers ──────────────────────────────────────────────────

function strList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).filter((s) => typeof s === 'string') as string[]
    : [];
}

/** Read humans.yaml and surface every entry as an OrgV2Node. Lenient —
 *  malformed file ⇒ empty list, same as Slice 3's reader. */
function readHumanNodes(): OrgV2Node[] {
  const p = humansYamlPath();
  if (!fs.existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>)['humans'];
  if (!Array.isArray(list)) return [];

  return list.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? (e['id'] as string) : '';
    const reportsRaw = e['reports_to'];
    const reports_to = typeof reportsRaw === 'string' && reportsRaw !== ''
      ? reportsRaw
      : null;
    return {
      id,
      type: 'human' as const,
      name: typeof e['name'] === 'string' ? (e['name'] as string) : id,
      role: typeof e['role'] === 'string' ? (e['role'] as string) : '',
      reports_to,
      lob: null,
      projects: [],
      skills: { primary: [] },
      owns: {
        scheduled_tasks: [],
        triggered_tasks: [],
        n8n_workflows: [],
        watchers: [],
      },
      four_rs: { role: '', responsibilities: [], results: [], requirements: [] },
      personality: { tone: '', pushback: '', format: '' },
      avatar: null,
      running: null,
      today_turns: null,
      scheduled_count: 0,
      triggered_count: 0,
    };
  }).filter((h) => h.id);
}

/** Per-agent runtime stats the endpoint mixes in — abstracted so
 *  dashboard.ts can supply them without this module touching the DB
 *  singleton or the launchd-pid filesystem. */
export interface AgentRuntimeStats {
  running: boolean;
  today_turns: number;
}

/** Read one agent.yaml and convert it into an OrgV2Node. Returns null
 *  if the file is missing / unparseable, same lenient policy as
 *  src/org-chart.ts. */
function readAgentNode(
  id: string,
  runtime: AgentRuntimeStats | undefined,
): OrgV2Node | null {
  const dir = resolveAgentDir(id);
  const yamlPath = path.join(dir, 'agent.yaml');
  if (!fs.existsSync(yamlPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = (yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, unknown>) || {};
  } catch {
    return null;
  }

  const fourRsRaw = (raw['four_rs'] as Record<string, unknown> | undefined) || {};
  const ownsRaw = (raw['owns'] as Record<string, unknown> | undefined) || {};
  const skillsRaw = (raw['skills'] as Record<string, unknown> | undefined) || {};
  const personalityRaw = (raw['personality'] as Record<string, unknown> | undefined) || {};

  // type — empty / missing defaults to "ai" for backwards-compat with
  // pre-Slice-10 agent.yaml files that were never re-migrated.
  const typeRaw = raw['type'];
  const type: 'ai' | 'human' = typeRaw === 'human' ? 'human' : 'ai';

  // reports_to — empty string ⇒ root (null on the wire).
  const reportsRaw = raw['reports_to'];
  const reports_to = typeof reportsRaw === 'string' && reportsRaw !== ''
    ? reportsRaw
    : null;

  const owns: OrgV2OwnsBlock = {
    scheduled_tasks: strList(ownsRaw['scheduled_tasks']),
    triggered_tasks: strList(ownsRaw['triggered_tasks']),
    n8n_workflows: strList(ownsRaw['n8n_workflows']),
    watchers: strList(ownsRaw['watchers']),
  };

  return {
    id,
    type,
    name: typeof raw['name'] === 'string' ? (raw['name'] as string) : id,
    role: typeof raw['description'] === 'string' ? (raw['description'] as string) : '',
    reports_to,
    lob: typeof raw['lob'] === 'string' ? (raw['lob'] as string) : '',
    projects: strList(raw['projects']),
    skills: { primary: strList(skillsRaw['primary']) },
    owns,
    four_rs: {
      // role / responsibilities / requirements live in CLAUDE.md prose;
      // we return empty defaults so the wire shape is stable.
      role: typeof fourRsRaw['role'] === 'string' ? (fourRsRaw['role'] as string) : '',
      responsibilities: strList(fourRsRaw['responsibilities']),
      results: strList(fourRsRaw['results']),
      requirements: strList(fourRsRaw['requirements']),
    },
    personality: {
      tone: typeof personalityRaw['tone'] === 'string' ? (personalityRaw['tone'] as string) : '',
      pushback: typeof personalityRaw['pushback'] === 'string' ? (personalityRaw['pushback'] as string) : '',
      format: typeof personalityRaw['format'] === 'string' ? (personalityRaw['format'] as string) : '',
    },
    avatar: typeof raw['avatar'] === 'string' && raw['avatar'] !== ''
      ? (raw['avatar'] as string)
      : null,
    running: runtime ? runtime.running : false,
    today_turns: runtime ? runtime.today_turns : 0,
    scheduled_count: owns.scheduled_tasks.length,
    triggered_count: owns.triggered_tasks.length,
  };
}

/** Public surface — every node on the org chart (humans first, then AI
 *  agents). The dashboard route supplies per-agent runtime stats; for
 *  unit-testing or stub callers, runtimeStats may be omitted (defaults
 *  to running:false, today_turns:0). */
export function readOrgChartV2(
  runtimeStats?: Map<string, AgentRuntimeStats>,
): OrgV2Node[] {
  const out: OrgV2Node[] = [];

  // Humans come first — gives a stable client-side rendering order
  // without the client having to sort by `type`.
  for (const h of readHumanNodes()) {
    out.push(h);
  }

  for (const id of listAgentIds()) {
    const node = readAgentNode(id, runtimeStats?.get(id));
    if (node) out.push(node);
  }

  return out;
}
