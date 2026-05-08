/**
 * Slice 6 — Multi-Agent Workflow type definitions.
 *
 * These types describe the YAML schema at workflows/{slug}.yaml and the
 * DB rows in workflow_runs / workflow_stages.
 */

export type StageType = 'sequential' | 'council';
export type ConsensusRule = 'majority' | 'unanimous' | 'threshold';
export type WorkflowState =
  | 'queued'
  | 'running'
  | 'approved'
  | 'escalated'
  | 'done'
  | 'failed';

export interface OnFailureSpec {
  retries: number;
  /** Agent slug or the literal string 'human' (creates an unassigned task). */
  escalate_to: string;
}

export interface SequentialStageSpec {
  name: string;
  type: 'sequential';
  agent: string;
  prompt: string;
  /** Optional per-stage allowed_paths additions (merged with workflow-level). */
  allowed_paths?: string[];
  on_failure: OnFailureSpec;
}

export interface CouncilStageSpec {
  name: string;
  type: 'council';
  agents: string[];
  consensus?: ConsensusRule;
  prompt: string;
  allowed_paths?: string[];
  on_failure: OnFailureSpec;
  /** For threshold rule: minimum approvals needed. Not used in slice 6. */
  threshold?: number;
}

export type StageSpec = SequentialStageSpec | CouncilStageSpec;

export interface WorkflowDefinition {
  slug: string;
  title: string;
  description?: string;
  default_consensus?: ConsensusRule;
  /** Workflow-level allowed_paths applied to every stage. */
  allowed_paths?: string[];
  stages: StageSpec[];
}

/** Runtime payload stored in workflow_runs.payload_json. */
export interface WorkflowRunPayload {
  /** Original input prompt the workflow was invoked with. */
  input: string;
  /** Outputs of completed stages, indexed by stage_idx. Council outputs
   *  are stored as a JSON-encoded array of per-member outputs. */
  outputs: Record<number, string>;
  /** Per-stage attempt counters (for retry tracking). */
  attempts: Record<number, number>;
  /** Last error string from the most recent failed stage (if any). */
  last_error?: string;
}
