/**
 * Slice 6 — Workflow YAML loader.
 *
 * Reads workflow definitions from workflows/{slug}.yaml, validates them,
 * and returns a typed WorkflowDefinition. Validation is deliberately
 * strict: a malformed workflow refuses to load rather than silently
 * running with a missing field, because the runtime enforcement layer
 * depends on the spec being well-formed.
 */

import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

import { PROJECT_ROOT } from './config.js';
import type {
  ConsensusRule,
  StageSpec,
  StageType,
  WorkflowDefinition,
} from './workflow-types.js';

const WORKFLOWS_DIR = path.join(PROJECT_ROOT, 'workflows');

const VALID_STAGE_TYPES: StageType[] = ['sequential', 'council'];
const VALID_CONSENSUS: ConsensusRule[] = ['majority', 'unanimous', 'threshold'];

/** Loads and validates a workflow definition by slug. Throws on bad YAML. */
export function loadWorkflow(slug: string): WorkflowDefinition {
  const file = path.join(WORKFLOWS_DIR, `${slug}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Workflow not found: ${slug} (looked at ${file})`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = yaml.load(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Workflow ${slug}: top-level YAML is not an object`);
  }
  const def = parsed as Partial<WorkflowDefinition>;

  if (def.slug !== slug) {
    throw new Error(
      `Workflow ${slug}: 'slug' field (${def.slug}) does not match filename`,
    );
  }
  if (!def.title || typeof def.title !== 'string') {
    throw new Error(`Workflow ${slug}: missing required 'title'`);
  }
  if (!Array.isArray(def.stages) || def.stages.length === 0) {
    throw new Error(`Workflow ${slug}: must have a non-empty 'stages' array`);
  }
  if (def.default_consensus && !VALID_CONSENSUS.includes(def.default_consensus)) {
    throw new Error(
      `Workflow ${slug}: invalid default_consensus '${def.default_consensus}'`,
    );
  }

  const stages: StageSpec[] = def.stages.map((s, idx) =>
    validateStage(slug, idx, s as Partial<StageSpec>),
  );

  return {
    slug,
    title: def.title,
    description: def.description,
    default_consensus: def.default_consensus ?? 'majority',
    allowed_paths: Array.isArray(def.allowed_paths) ? def.allowed_paths : [],
    stages,
  };
}

function validateStage(
  slug: string,
  idx: number,
  s: Partial<StageSpec>,
): StageSpec {
  if (!s.name || typeof s.name !== 'string') {
    throw new Error(`Workflow ${slug} stage[${idx}]: missing 'name'`);
  }
  if (!s.type || !VALID_STAGE_TYPES.includes(s.type as StageType)) {
    throw new Error(
      `Workflow ${slug} stage[${idx}]: invalid type '${s.type}' (must be sequential|council)`,
    );
  }
  if (!s.prompt || typeof s.prompt !== 'string') {
    throw new Error(`Workflow ${slug} stage[${idx}]: missing 'prompt'`);
  }
  if (!s.on_failure || typeof s.on_failure !== 'object') {
    throw new Error(`Workflow ${slug} stage[${idx}]: missing 'on_failure'`);
  }
  if (typeof s.on_failure.retries !== 'number' || s.on_failure.retries < 0) {
    throw new Error(
      `Workflow ${slug} stage[${idx}]: on_failure.retries must be >= 0`,
    );
  }
  if (!s.on_failure.escalate_to || typeof s.on_failure.escalate_to !== 'string') {
    throw new Error(
      `Workflow ${slug} stage[${idx}]: on_failure.escalate_to must be a non-empty string`,
    );
  }

  if (s.type === 'sequential') {
    const seq = s as Partial<import('./workflow-types.js').SequentialStageSpec>;
    if (!seq.agent || typeof seq.agent !== 'string') {
      throw new Error(
        `Workflow ${slug} stage[${idx}]: sequential stage missing 'agent'`,
      );
    }
    return {
      name: seq.name!,
      type: 'sequential',
      agent: seq.agent,
      prompt: seq.prompt!,
      allowed_paths: Array.isArray(seq.allowed_paths) ? seq.allowed_paths : undefined,
      on_failure: seq.on_failure!,
    };
  }

  // council
  const council = s as Partial<import('./workflow-types.js').CouncilStageSpec>;
  if (!Array.isArray(council.agents) || council.agents.length < 2) {
    throw new Error(
      `Workflow ${slug} stage[${idx}]: council stage requires >=2 'agents'`,
    );
  }
  if (council.consensus && !VALID_CONSENSUS.includes(council.consensus)) {
    throw new Error(
      `Workflow ${slug} stage[${idx}]: invalid consensus '${council.consensus}'`,
    );
  }
  return {
    name: council.name!,
    type: 'council',
    agents: council.agents,
    consensus: council.consensus,
    prompt: council.prompt!,
    allowed_paths: Array.isArray(council.allowed_paths) ? council.allowed_paths : undefined,
    on_failure: council.on_failure!,
    threshold: council.threshold,
  };
}

/** Lists all workflow slugs available on disk. */
export function listWorkflowSlugs(): string[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''));
}

/** Loads all workflows. Skips any that fail validation but logs a warning. */
export function loadAllWorkflows(): WorkflowDefinition[] {
  const out: WorkflowDefinition[] = [];
  for (const slug of listWorkflowSlugs()) {
    try {
      out.push(loadWorkflow(slug));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[workflow-loader] skipping ${slug}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Computes the merged allowed_paths list for a given stage. */
export function effectiveAllowedPaths(
  def: WorkflowDefinition,
  stage: StageSpec,
): string[] {
  const merged = new Set<string>();
  for (const p of def.allowed_paths ?? []) merged.add(p);
  for (const p of stage.allowed_paths ?? []) merged.add(p);
  return [...merged];
}
