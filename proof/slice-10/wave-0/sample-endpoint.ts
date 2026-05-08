#!/usr/bin/env tsx
/**
 * Drive readOrgChartV2() directly without booting the dashboard, so we
 * can capture a representative endpoint payload for proof. Outputs JSON
 * to stdout. The runtime-stats Map is stubbed because nothing on this
 * worktree is launchd-managed — the real /api/org-chart-v2 endpoint
 * fills `running` / `today_turns` from the dashboard's pid-file probe.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { readOrgChartV2, type AgentRuntimeStats } from '../../../src/org-chart-v2.js';
import { listAgentIds } from '../../../src/agent-config.js';

const __filename = fileURLToPath(import.meta.url);

// Stub runtime stats — match what dashboard.ts builds at request time.
// Demo values: ai agents are "running:true" with a fixed turn count so
// the proof artifact shows the field plumbed through.
const runtime = new Map<string, AgentRuntimeStats>();
for (const id of listAgentIds()) {
  runtime.set(id, { running: true, today_turns: 0 });
}

const nodes = readOrgChartV2(runtime);
process.stdout.write(JSON.stringify({ nodes }, null, 2));
process.stdout.write('\n');
