/**
 * Slice 6 — Workflow stage spawner.
 *
 * Mirrors the SDK invocation in src/agent.ts but:
 *   1. Adds an in-process `hooks: { PreToolUse }` callback that DENIES
 *      Edit/Write outside the per-stage allowed_paths set, and
 *   2. Adds `disallowedTools` so the SDK refuses to surface listed
 *      tools at all (belt-and-suspenders alongside the hook).
 *
 * Strictly additive: src/agent.ts is unchanged, so solo mission_tasks
 * and Telegram chat continue to use the unhooked code path.
 *
 * The hook runs ONLY for workflow stages — never globally. It is
 * passed per call to `query()` here, scoped to the spawn.
 */

import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { agentMcpAllowlist, PROJECT_ROOT } from './config.js';
import { loadAgentConfig, resolveAgentDir } from './agent-config.js';
import { loadMcpServers } from './agent.js';
import { readEnvFile } from './env.js';
import { getScrubbedSdkEnv } from './security.js';
import { logger } from './logger.js';
import { requireEnabled } from './kill-switches.js';

const PROTECTED_TOOL_NAMES = ['Edit', 'Write', 'NotebookEdit'];

export interface WorkflowSpawnOptions {
  /** Workflow stage agent slug (used to set cwd to that agent's dir). */
  agentId: string;
  /** Prompt text to send (already templated upstream). */
  prompt: string;
  /** Allow-listed paths. Edits below these prefixes are permitted. */
  allowedPaths: string[];
  /** Optional model override; defaults to the agent's configured model. */
  model?: string;
  /** Optional abort controller. */
  abortController?: AbortController;
  /** Stage label used in log/event records. */
  stageLabel: string;
  /** Run id for log correlation. */
  runId: string;
}

export interface WorkflowSpawnResult {
  text: string | null;
  blocked: { tool: string; targetPath: string; reason: string }[];
  /** Verdict parsed from trailing line, or 'UNKNOWN'. */
  verdict: 'APPROVED' | 'REJECTED' | 'UNKNOWN';
  aborted?: boolean;
}

/**
 * Build a PreToolUse hook callback that blocks Edit/Write/NotebookEdit
 * on any path NOT under the per-stage allowed_paths set. Returns the
 * callback plus an array that captures every block decision (used as
 * proof + dashboard evidence).
 */
export function buildDenyEditHook(
  allowedPaths: string[],
  blocks: { tool: string; targetPath: string; reason: string }[],
): HookCallback {
  // Normalise allowed prefixes to absolute (or project-root-relative).
  // We resolve relative-to-PROJECT_ROOT — workflow YAML uses repo-root
  // relative paths like "tasks.md" or "memory/" so this is the natural
  // anchor.
  const allowedPrefixes = allowedPaths.map((p) => {
    const trimmed = p.replace(/\/+$/, '');
    if (path.isAbsolute(trimmed)) return trimmed;
    return path.resolve(PROJECT_ROOT, trimmed);
  });

  return async (input, _toolUseID, _opts): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const toolName = input.tool_name;
    if (!PROTECTED_TOOL_NAMES.includes(toolName)) return { continue: true };
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const target =
      (toolInput.file_path as string | undefined) ??
      (toolInput.notebook_path as string | undefined) ??
      '';

    if (!target) {
      // No path means we can't reason about it — allow but log.
      return { continue: true };
    }

    const abs = path.isAbsolute(target) ? target : path.resolve(PROJECT_ROOT, target);
    const allowed = allowedPrefixes.some((prefix) => {
      // Exact-file match OR directory-prefix match (with trailing /).
      if (abs === prefix) return true;
      return abs.startsWith(prefix + path.sep);
    });

    if (allowed) return { continue: true };

    const reason =
      `Slice 6 workflow stage may not ${toolName} ${target}. ` +
      `Allowed prefixes: ${allowedPaths.join(', ') || '(none)'}. ` +
      `This is a runtime-enforced manager-only role per agent-teams/big-idea.md.`;
    blocks.push({ tool: toolName, targetPath: target, reason });
    logger.warn({ tool: toolName, target, allowedPaths }, 'Slice 6 PreToolUse hook blocked edit');

    return {
      decision: 'block',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}

/** Parse a trailing `VERDICT: ...` line out of an agent's response. */
export function parseVerdict(text: string | null): 'APPROVED' | 'REJECTED' | 'UNKNOWN' {
  if (!text) return 'UNKNOWN';
  const trimmed = text.trim();
  // Look for the LAST occurrence of a verdict line, case-insensitive.
  const matches = [...trimmed.matchAll(/VERDICT\s*:\s*(APPROVED|REJECTED)/gi)];
  if (matches.length === 0) return 'UNKNOWN';
  const last = matches[matches.length - 1];
  const verdict = last[1]!.toUpperCase();
  return verdict === 'APPROVED' || verdict === 'REJECTED' ? verdict : 'UNKNOWN';
}

/**
 * Stub mode — when set, spawnWorkflowStage returns a deterministic
 * scripted response instead of calling the SDK. Used by proof scripts
 * (`proof/slice-6/proof-runner.ts`) and the playwright e2e harness so
 * we can validate the state machine without spending tokens. NEVER
 * defaults to true; only the proof script flips it on.
 */
type Scripted = {
  text: string;
  verdict?: 'APPROVED' | 'REJECTED' | 'UNKNOWN';
  blocked?: { tool: string; targetPath: string; reason: string }[];
};
let stubMode: { enabled: boolean; queue: Scripted[] } = { enabled: false, queue: [] };

export function enableStubMode(scripted: Scripted[]): void {
  stubMode = { enabled: true, queue: [...scripted] };
}
export function disableStubMode(): void {
  stubMode = { enabled: false, queue: [] };
}

/**
 * Spawn a single workflow stage call. This bypasses src/agent.ts and
 * src/scheduler.ts: they continue to handle solo mission_tasks. The
 * workflow runner uses this function for every stage so the hook
 * scoping is per-spawn, never global.
 */
export async function spawnWorkflowStage(
  opts: WorkflowSpawnOptions,
): Promise<WorkflowSpawnResult> {
  // Honor LLM_SPAWN_ENABLED kill switch — same chokepoint as src/agent.ts
  // so workflows can't bypass an emergency stop.
  requireEnabled('LLM_SPAWN_ENABLED');

  if (stubMode.enabled) {
    const next = stubMode.queue.shift();
    const text = next?.text ?? `[stub] stage ${opts.stageLabel}`;
    return {
      text,
      blocked: next?.blocked ?? [],
      verdict: next?.verdict ?? parseVerdict(text),
    };
  }

  const blocks: { tool: string; targetPath: string; reason: string }[] = [];
  const hook = buildDenyEditHook(opts.allowedPaths, blocks);

  // Resolve agent cwd. We deliberately use the target stage agent's
  // directory (so its CLAUDE.md / agent.yaml load via settingSources),
  // independent of which agent triggered the workflow. loadAgentConfig
  // can throw if the agent.yaml is missing — let it propagate so the
  // runner records the failure on the stage row.
  let stageCwd = PROJECT_ROOT;
  let stageModel = opts.model;
  let mcpAllow: string[] | undefined = agentMcpAllowlist;
  try {
    const agentCfg = loadAgentConfig(opts.agentId);
    stageCwd = resolveAgentDir(opts.agentId);
    if (!stageModel) stageModel = agentCfg.model;
    if (agentCfg.mcpServers) mcpAllow = agentCfg.mcpServers;
  } catch (err) {
    logger.warn(
      { agentId: opts.agentId, err: (err as Error).message },
      'Slice 6 stage agent config not loadable, falling back to PROJECT_ROOT',
    );
  }

  // MCP servers: limit to whatever the target agent normally allows.
  // We intentionally do NOT include the in-process whatsapp helper for
  // workflow stages — those should be focused on dispatch + reasoning.
  const mcpServers = loadMcpServers(mcpAllow, stageCwd);

  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const sdkEnv = getScrubbedSdkEnv(secrets);

  let resultText: string | null = null;

  logger.info(
    { runId: opts.runId, stage: opts.stageLabel, agent: opts.agentId, cwd: stageCwd, allowedPaths: opts.allowedPaths },
    'Slice 6 spawning workflow stage',
  );

  try {
    for await (const event of query({
      prompt: (async function* () {
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: opts.prompt },
          parent_tool_use_id: null,
          session_id: '',
        };
      })(),
      options: {
        cwd: stageCwd,
        settingSources: ['project', 'user'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: sdkEnv,
        mcpServers,
        // Belt-and-suspenders: also list these in disallowedTools so the
        // SDK refuses to surface them. The hook is the load-bearing
        // enforcement; this just narrows the model's surface.
        // Note: we DON'T disallow Edit/Write outright because some
        // edits (to allowed_paths) are legitimate; the hook decides
        // per-path.
        ...(stageModel ? { model: stageModel } : {}),
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
        hooks: {
          PreToolUse: [
            { matcher: 'Edit|Write|NotebookEdit', hooks: [hook], timeout: 5 },
          ],
        },
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;
      }
    }
  } catch (err) {
    if (opts.abortController?.signal.aborted) {
      return { text: null, blocked: blocks, verdict: 'UNKNOWN', aborted: true };
    }
    throw err;
  }

  return {
    text: resultText,
    blocked: blocks,
    verdict: parseVerdict(resultText),
  };
}
