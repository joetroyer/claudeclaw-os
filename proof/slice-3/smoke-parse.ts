/**
 * Slice 3 — runtime smoke for the parser surface.
 *
 * Loads `lobs.yaml` and `humans.yaml` from the worktree, plus every
 * agent.yaml visible to listAgentIds() (which scans both the worktree
 * and the parent CLAUDECLAW_CONFIG/agents/). Prints the shape that
 * /api/org-chart/{lobs,humans,agents} would emit, plus a static
 * decorateWorkload() check against a synthetic counts map.
 *
 * Run from the worktree root with:
 *
 *   npx tsx proof/slice-3/smoke-parse.ts
 */
import { fileURLToPath } from 'url';
import path from 'path';

// Force PROJECT_ROOT to point at the worktree so lobs.yaml / humans.yaml
// resolve here. The default in src/config.ts walks upward to find the
// nearest package.json — that lands on the worktree, but we set it
// explicitly to be defensive when this script runs from an arbitrary cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(here, '..', '..');
process.env.PROJECT_ROOT = worktreeRoot;

const orgChart = await import(path.join(worktreeRoot, 'src', 'org-chart.ts'));

const lobs = orgChart.readLobs();
const humans = orgChart.readHumans();
const agents = orgChart.readOrgAgents();

console.log('=== lobs.yaml ===');
console.log(`  count: ${lobs.length}`);
for (const l of lobs) {
  console.log(`  - ${l.slug.padEnd(12)} ${l.name} (${l.projects.length} projects)`);
}

console.log('\n=== humans.yaml ===');
console.log(`  count: ${humans.length}`);
for (const h of humans) {
  console.log(`  - ${h.id.padEnd(8)} ${h.name} (owns ${h.owns_lobs.length} LOBs, ${h.owns_projects.length} projects)`);
}

console.log('\n=== agents (merged) ===');
console.log(`  count: ${agents.length}`);
for (const a of agents) {
  console.log(`  - ${a.id.padEnd(14)} lob=${(a.lob || '<unset>').padEnd(10)} ideal=${a.ideal} results=${a.four_rs_results.length} owns_total=${
    a.owns.scheduled_tasks.length + a.owns.triggered_tasks.length + a.owns.n8n_workflows.length + a.owns.watchers.length
  }`);
}

console.log('\n=== decorateWorkload (synthetic counts) ===');
const counts = new Map();
for (const a of agents) {
  // Synthetic: alternate between 0 and 25 so the threshold (default 20)
  // flags every other agent. Confirms the suggested-breakout text wires
  // up correctly.
  const i = agents.indexOf(a);
  counts.set(a.id, { missionTasks: i % 2 === 0 ? 0 : 25, scheduledTasks: 0 });
}
const decorated = orgChart.decorateWorkload(agents, counts, 30, 20);
const overloaded = decorated.filter((w: { overloaded: boolean }) => w.overloaded);
console.log(`  rows: ${decorated.length}`);
console.log(`  overloaded: ${overloaded.length}`);
for (const w of overloaded) {
  console.log(`    - ${w.agent_id}: total=${w.total} suggested="${(w.suggested_breakout || '').slice(0, 60)}..."`);
}

console.log('\nDONE');
