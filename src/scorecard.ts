/**
 * Slice 5 — Performance Scorecard + Budget rollups.
 *
 * Composes:
 *   - token_usage rollups by agent (db.ts: getTokenRollupByAgent)
 *   - mission_tasks rollups by agent (db.ts: getMissionRollupByAgent)
 *   - agent metadata (lob / projects / platform) from agent.yaml
 *   - pricing.yaml-driven cost recomputation (cost.ts)
 *
 * Cost recomputation: token_usage.cost_usd was written at log time using
 * whatever rate the bot knew about. Slice 5 makes pricing data-driven —
 * we recompute cost at query time from (platform, model, tokens) so the
 * scorecard reflects the *current* pricing.yaml. The on-disk cost_usd
 * column is kept untouched (data-integrity contract).
 */
import {
  getTokenRollupByAgent,
  getMissionRollupByAgent,
  type TokenRollupRow,
  type MissionRollupRow,
} from './db.js';
import { listAgentSliceMetadata, type AgentSliceMetadata } from './agent-config.js';
import { computeCost, isSubscription } from './cost.js';

/** Pre-canned windows the API surface exposes. */
export type ScorecardWindow = '1d' | '7d' | '30d' | '90d' | 'all';

/** Convert a window keyword to a unix-seconds threshold. 'all' returns 0. */
export function windowStartUnix(window: ScorecardWindow, now: number = Date.now()): number {
  if (window === 'all') return 0;
  const days = window === '1d' ? 1 : window === '7d' ? 7 : window === '30d' ? 30 : 90;
  return Math.floor(now / 1000) - days * 86_400;
}

/** Slice 5 — one row per agent for the scorecard view. */
export interface ScorecardRow {
  agent_id: string;
  name: string;
  description: string;
  model: string | null;
  platform: string;
  lob: string;
  projects: string[];
  ideal: boolean;
  /** Token totals over the window. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Per-spec: cost is $0 with subscription_flag=1 when subscription. */
  costUsd: number;
  subscription_flag: 0 | 1;
  /** Recorded cost from token_usage.cost_usd (so the convolife query
   *  shape stays comparable). Not displayed in the scorecard UI. */
  recordedCostUsd: number;
  /** Mission completion stats over the window. */
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  /** completed / (completed + failed). null when neither happened. */
  completionRate: number | null;
  /** Avg seconds per completed task; null when none completed. */
  avgDurationSec: number | null;
  /** Avg tokens per task (mission task or, if none, per turn fallback). */
  avgTokensPerTask: number | null;
  /** Avg cost per task in dollars. Null for subscription. */
  avgCostPerTask: number | null;
}

/** Compute the full scorecard for the given window. */
export function getScorecard(window: ScorecardWindow): {
  window: ScorecardWindow;
  generatedAt: number;
  rows: ScorecardRow[];
} {
  const start = windowStartUnix(window);
  const tokenRows = getTokenRollupByAgent(start);
  const missionRows = getMissionRollupByAgent(start);
  const agents = listAgentSliceMetadata();

  // Index rollups by agent_id for fast lookup. Agents that never logged
  // a turn or task in the window still appear with zeroes.
  const tokenIdx = new Map<string, TokenRollupRow>();
  for (const row of tokenRows) tokenIdx.set(row.agent_id, row);
  const missionIdx = new Map<string, MissionRollupRow>();
  for (const row of missionRows) missionIdx.set(row.agent_id, row);

  // Capture every agent_id that shows up in either rollup so we don't
  // drop deleted agents from historical reports — but cap with the
  // configured roster too. Use a Set to dedupe.
  const allIds = new Set<string>();
  for (const a of agents) allIds.add(a.id);
  for (const r of tokenRows) if (r.agent_id) allIds.add(r.agent_id);
  for (const r of missionRows) if (r.agent_id) allIds.add(r.agent_id);

  const agentMetaIdx = new Map<string, AgentSliceMetadata>();
  for (const a of agents) agentMetaIdx.set(a.id, a);

  const rows: ScorecardRow[] = [];
  for (const id of allIds) {
    const meta = agentMetaIdx.get(id);
    const t = tokenIdx.get(id) ?? {
      agent_id: id, turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
    };
    const m = missionIdx.get(id) ?? {
      agent_id: id, total: 0, completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0,
      avgDurationSec: null,
    };

    const platform = meta?.platform || (id === 'main' ? 'claude' : '');
    const isSub = isSubscription(platform);

    // Recompute cost from pricing.yaml. Subscription → $0 with flag.
    const costResult = computeCost(platform, meta?.model ?? null, t.inputTokens, t.outputTokens);
    const costUsd = costResult.cost;

    const denom = m.completed + m.failed;
    const completionRate = denom > 0 ? m.completed / denom : null;
    const taskCount = m.total > 0 ? m.total : null;
    const avgTokensPerTask = taskCount ? Math.round(t.totalTokens / taskCount) : null;
    const avgCostPerTask = taskCount && !isSub ? costUsd / taskCount : null;

    rows.push({
      agent_id: id,
      name: meta?.name ?? id,
      description: meta?.description ?? '',
      model: meta?.model ?? null,
      platform,
      lob: meta?.lob ?? '',
      projects: meta?.projects ?? [],
      ideal: meta?.ideal ?? false,
      turns: t.turns,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      totalTokens: t.totalTokens,
      costUsd,
      subscription_flag: costResult.subscription_flag,
      recordedCostUsd: t.costUsd,
      tasksTotal: m.total,
      tasksCompleted: m.completed,
      tasksFailed: m.failed,
      tasksCancelled: m.cancelled,
      completionRate,
      avgDurationSec: m.avgDurationSec ?? null,
      avgTokensPerTask,
      avgCostPerTask,
    });
  }

  // Stable sort: ideal=true agents to the bottom, then by total tokens desc.
  rows.sort((a, b) => {
    if (a.ideal !== b.ideal) return a.ideal ? 1 : -1;
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    return a.name.localeCompare(b.name);
  });

  return { window, generatedAt: Math.floor(Date.now() / 1000), rows };
}

/** Slice 5 — Budget rollup grouped by line of business and project.
 *  Agents whose `lob` is empty roll up under "Unassigned". */
export interface BudgetGroup {
  key: string;
  /** Pretty label (matches key for now; UI may reuse). */
  label: string;
  costUsd: number;
  totalTokens: number;
  turns: number;
  agents: string[];
  /** True when at least one agent in the group is on a subscription
   *  platform. UI shows the badge so $0 isn't misread as "no spend". */
  hasSubscription: boolean;
}

export interface BudgetReport {
  window: ScorecardWindow;
  generatedAt: number;
  byLob: BudgetGroup[];
  byProject: BudgetGroup[];
}

const UNASSIGNED = 'Unassigned';

/** Compute budget rollups by LOB and by project for the given window. */
export function getBudget(window: ScorecardWindow): BudgetReport {
  const sc = getScorecard(window);

  const lobIdx = new Map<string, BudgetGroup>();
  const projIdx = new Map<string, BudgetGroup>();

  function bump(idx: Map<string, BudgetGroup>, key: string, row: ScorecardRow): void {
    let group = idx.get(key);
    if (!group) {
      group = { key, label: key, costUsd: 0, totalTokens: 0, turns: 0, agents: [], hasSubscription: false };
      idx.set(key, group);
    }
    group.costUsd += row.costUsd;
    group.totalTokens += row.totalTokens;
    group.turns += row.turns;
    if (!group.agents.includes(row.agent_id)) group.agents.push(row.agent_id);
    if (row.subscription_flag === 1) group.hasSubscription = true;
  }

  for (const row of sc.rows) {
    const lobKey = row.lob && row.lob.trim() ? row.lob.trim() : UNASSIGNED;
    bump(lobIdx, lobKey, row);

    if (row.projects.length === 0) {
      bump(projIdx, UNASSIGNED, row);
    } else {
      for (const proj of row.projects) {
        const key = proj && proj.trim() ? proj.trim() : UNASSIGNED;
        bump(projIdx, key, row);
      }
    }
  }

  const byLob = [...lobIdx.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  const byProject = [...projIdx.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  return { window, generatedAt: sc.generatedAt, byLob, byProject };
}
