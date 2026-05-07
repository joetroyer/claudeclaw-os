/**
 * Slice 3 — Org Chart View (read-only).
 *
 * Pure consumers of:
 *   - lobs.yaml             — line-of-business hierarchy
 *   - humans.yaml           — named people on the chart
 *   - agents/<id>/agent.yaml — Slice-1 metadata (lob, projects, ideal,
 *                              four_rs.results, owns.*, skills.primary,
 *                              avatar, platform)
 *   - mission_tasks + scheduled_tasks — workload counts over a window
 *
 * NEVER writes anything. The dashboard exposes these via four GET
 * endpoints under /api/org-chart/. Adding a write here would break the
 * Slice 3 integration contract.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { PROJECT_ROOT } from './config.js';
import { listAgentIds, resolveAgentDir } from './agent-config.js';

// ── types ────────────────────────────────────────────────────────────

export interface LobProject {
  slug: string;
  name: string;
}

export interface Lob {
  slug: string;
  name: string;
  description: string;
  projects: LobProject[];
}

export interface Human {
  id: string;
  name: string;
  role: string;
  owns_lobs: string[];
  owns_projects: string[];
}

export interface OrgAgent {
  id: string;
  name: string;
  description: string;
  lob: string;
  projects: string[];
  ideal: boolean;
  platform: string;
  four_rs_results: string[];
  skills_primary: string[];
  owns: {
    scheduled_tasks: string[];
    triggered_tasks: string[];
    n8n_workflows: string[];
    watchers: string[];
  };
  avatar: string;
}

export interface AgentWorkload {
  agent_id: string;
  mission_tasks: number;
  scheduled_tasks: number;
  total: number;
  overloaded: boolean;
  suggested_breakout: string | null;
}

// ── path helpers ─────────────────────────────────────────────────────

function lobsYamlPath(): string {
  return path.join(PROJECT_ROOT, 'lobs.yaml');
}

function humansYamlPath(): string {
  return path.join(PROJECT_ROOT, 'humans.yaml');
}

// ── parsers ──────────────────────────────────────────────────────────

/** Parse lobs.yaml; returns [] when the file is missing or malformed
 *  rather than throwing. The dashboard surfaces "no LOBs configured"
 *  cleanly when the seed file hasn't been authored yet. */
export function readLobs(): Lob[] {
  const p = lobsYamlPath();
  if (!fs.existsSync(p)) return [];
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>)['lobs'];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const projectsRaw = Array.isArray(e['projects']) ? (e['projects'] as unknown[]) : [];
    const projects: LobProject[] = projectsRaw.map((proj) => {
      const pr = (proj ?? {}) as Record<string, unknown>;
      return {
        slug: typeof pr['slug'] === 'string' ? (pr['slug'] as string) : '',
        name: typeof pr['name'] === 'string' ? (pr['name'] as string) : '',
      };
    }).filter((pr) => pr.slug);
    return {
      slug: typeof e['slug'] === 'string' ? (e['slug'] as string) : '',
      name: typeof e['name'] === 'string' ? (e['name'] as string) : '',
      description: typeof e['description'] === 'string' ? (e['description'] as string) : '',
      projects,
    };
  }).filter((l) => l.slug);
}

/** Parse humans.yaml; same lenient policy as readLobs(). */
export function readHumans(): Human[] {
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
    const ownsLobsRaw = e['owns_lobs'];
    const ownsProjsRaw = e['owns_projects'];
    return {
      id: typeof e['id'] === 'string' ? (e['id'] as string) : '',
      name: typeof e['name'] === 'string' ? (e['name'] as string) : '',
      role: typeof e['role'] === 'string' ? (e['role'] as string) : '',
      owns_lobs: Array.isArray(ownsLobsRaw) ? (ownsLobsRaw as unknown[]).filter((s) => typeof s === 'string') as string[] : [],
      owns_projects: Array.isArray(ownsProjsRaw) ? (ownsProjsRaw as unknown[]).filter((s) => typeof s === 'string') as string[] : [],
    };
  }).filter((h) => h.id);
}

/** Read the raw agent.yaml for one agent and pull the Slice-1 fields
 *  the org chart cares about. We re-parse here (rather than going
 *  through `loadAgentConfig`) because the existing loader strips the
 *  Slice-1 metadata — it only returns persona/runtime fields. The org
 *  chart needs the full structured surface area. */
function readOrgAgent(id: string): OrgAgent | null {
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
  const fourRsResults = Array.isArray(fourRsRaw['results'])
    ? (fourRsRaw['results'] as unknown[]).filter((s) => typeof s === 'string') as string[]
    : [];

  const ownsRaw = (raw['owns'] as Record<string, unknown> | undefined) || {};
  function strList(field: string): string[] {
    const v = ownsRaw[field];
    return Array.isArray(v) ? (v as unknown[]).filter((s) => typeof s === 'string') as string[] : [];
  }

  const skillsRaw = (raw['skills'] as Record<string, unknown> | undefined) || {};
  const skillsPrimary = Array.isArray(skillsRaw['primary'])
    ? (skillsRaw['primary'] as unknown[]).filter((s) => typeof s === 'string') as string[]
    : [];

  const projectsRaw = raw['projects'];
  const projects = Array.isArray(projectsRaw)
    ? (projectsRaw as unknown[]).filter((s) => typeof s === 'string') as string[]
    : [];

  return {
    id,
    name: typeof raw['name'] === 'string' ? (raw['name'] as string) : id,
    description: typeof raw['description'] === 'string' ? (raw['description'] as string) : '',
    lob: typeof raw['lob'] === 'string' ? (raw['lob'] as string) : '',
    projects,
    ideal: raw['ideal'] === true,
    platform: typeof raw['platform'] === 'string' ? (raw['platform'] as string) : '',
    four_rs_results: fourRsResults,
    skills_primary: skillsPrimary,
    owns: {
      scheduled_tasks: strList('scheduled_tasks'),
      triggered_tasks: strList('triggered_tasks'),
      n8n_workflows: strList('n8n_workflows'),
      watchers: strList('watchers'),
    },
    avatar: typeof raw['avatar'] === 'string' ? (raw['avatar'] as string) : '',
  };
}

/** Public surface — every agent's org-chart-relevant metadata, in
 *  whatever order listAgentIds() returns them. Skips agents whose
 *  YAML can't be parsed (same lenient policy as elsewhere in the
 *  dashboard). */
export function readOrgAgents(): OrgAgent[] {
  const out: OrgAgent[] = [];
  for (const id of listAgentIds()) {
    const a = readOrgAgent(id);
    if (a) out.push(a);
  }
  return out;
}

// ── workload analytics ───────────────────────────────────────────────

/** Default analytics window: last 30 days. Configurable via the API
 *  query string (`?days=N`). */
export const DEFAULT_WINDOW_DAYS = 30;

/** Default overload threshold: more than this many tasks in the
 *  window flips the agent into the "overloaded" bucket and triggers
 *  the suggested-breakout text. Configurable via `?threshold=N`. */
export const DEFAULT_OVERLOAD_THRESHOLD = 20;

/** Per-agent task counts as returned by db.getAgentWorkloadCounts. */
export interface WorkloadCounts {
  missionTasks: number;
  scheduledTasks: number;
}

/** Decorate raw counts into the org-chart workload shape — adds the
 *  overload flag and the (optional) suggested-breakout text the
 *  Analytics tab surfaces.
 *
 *  This stays pure: the caller (dashboard.ts) is responsible for
 *  fetching counts via db.getAgentWorkloadCounts so this module
 *  doesn't touch the SQLite singleton. */
export function decorateWorkload(
  agents: OrgAgent[],
  counts: Map<string, WorkloadCounts>,
  windowDays = DEFAULT_WINDOW_DAYS,
  overloadThreshold = DEFAULT_OVERLOAD_THRESHOLD,
): AgentWorkload[] {
  return agents.map((a) => {
    const c = counts.get(a.id) ?? { missionTasks: 0, scheduledTasks: 0 };
    const total = c.missionTasks + c.scheduledTasks;
    const overloaded = total > overloadThreshold;
    const suggested = overloaded
      ? `${a.name} is carrying ${total} tasks in the last ${windowDays}d (threshold ${overloadThreshold}). Consider splitting responsibilities — narrow ${a.name}'s scope or spawn a specialist for the heaviest project.`
      : null;
    return {
      agent_id: a.id,
      mission_tasks: c.missionTasks,
      scheduled_tasks: c.scheduledTasks,
      total,
      overloaded,
      suggested_breakout: suggested,
    };
  });
}
