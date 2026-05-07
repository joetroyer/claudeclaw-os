/**
 * Slice 3 — runtime smoke for the four new GET routes.
 *
 * Spins up the Hono app via buildDashboardApp() (the same factory the
 * production server uses) and exercises each /api/org-chart/* route
 * via app.request(). No HTTP server, no port binding — same pattern
 * the project already uses for contract tests.
 *
 * Run from the worktree root with:
 *
 *   DASHBOARD_TOKEN=test npx tsx proof/slice-3/smoke-routes.ts
 *
 * Set CLAUDECLAW_CONFIG to use a different agents directory (e.g. the
 * parent repo's populated agents/).
 */
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(here, '..', '..');
process.env.PROJECT_ROOT = worktreeRoot;
// initDatabase() is required by db.ts module-level state; point it at
// an in-memory DB if the operator hasn't set one. Cheap, no I/O.
process.env.DATABASE_URL = process.env.DATABASE_URL || ':memory:';
process.env.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'smoke-test-token';
// Bypass bot-token validation for the agents we won't actually call.
// loadAgentConfig() throws when the env var is missing; the org-chart
// routes don't go through that loader (they re-parse YAML directly),
// so we don't need bot tokens for the parsers themselves. Just keeping
// initDatabase happy.

// initDatabase() requires DB_ENCRYPTION_KEY + a working better-sqlite3
// native build. On dev machines where the native binding is mismatched
// (Node 25 vs an older NODE_MODULE_VERSION), the smoke would die here.
// Skip DB init when SMOKE_SKIP_DB=1; the lobs/humans/agents endpoints
// don't touch the DB, and the workload route will surface 0s instead of
// throwing because getAgentWorkloadCounts catches the prepare() failure.
const skipDb = process.env.SMOKE_SKIP_DB === '1';
if (!skipDb) {
  const dbMod = await import(path.join(worktreeRoot, 'src', 'db.ts'));
  dbMod.initDatabase();
}

const { buildDashboardApp } = await import(path.join(worktreeRoot, 'src', 'dashboard.ts'));
const app = buildDashboardApp();

const TOKEN = process.env.DASHBOARD_TOKEN;
const dbDependent = ['/api/org-chart/workload?token=', '/api/org-chart/workload?token='];
const paths = [
  `/api/org-chart/lobs?token=${TOKEN}`,
  `/api/org-chart/humans?token=${TOKEN}`,
  `/api/org-chart/agents?token=${TOKEN}`,
  ...(skipDb ? [] : [
    `/api/org-chart/workload?token=${TOKEN}`,
    `/api/org-chart/workload?token=${TOKEN}&days=7&threshold=5`,
  ]),
];
void dbDependent;

for (const p of paths) {
  const res = await app.request(`http://local${p}`);
  const status = res.status;
  let body: unknown;
  try { body = await res.json(); } catch { body = await res.text(); }
  const summary =
    typeof body === 'object' && body
      ? Object.fromEntries(
          Object.entries(body as Record<string, unknown>).map(([k, v]) => [
            k,
            Array.isArray(v) ? `[${v.length} items]` : v,
          ]),
        )
      : body;
  console.log(`GET ${p.split('?')[0]} → ${status}`);
  console.log('   ', JSON.stringify(summary));
}

// Authorisation gate: a request without a token must 401.
const unauthRes = await app.request('http://local/api/org-chart/lobs');
console.log(`GET /api/org-chart/lobs (no token) → ${unauthRes.status} (expected 401)`);

// Method gate: POST/PATCH/DELETE on an org-chart path must NOT be
// implemented. The Hono app doesn't register any non-GET handler so it
// falls through to the SPA-shell fallback (200 with HTML). That's fine
// for clients but the explicit assertion is "no mutation handler with
// /api/org-chart prefix exists". Verified by inspecting routes.
const orgRoutes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
  .filter((r) => r.path.startsWith('/api/org-chart'))
  .map((r) => `${r.method} ${r.path}`);
console.log('\nregistered org-chart routes:');
for (const r of orgRoutes) console.log(`  ${r}`);
const nonGet = orgRoutes.filter((r) => !r.startsWith('GET '));
if (nonGet.length > 0) {
  console.error(`FAIL: non-GET org-chart routes detected: ${nonGet.join(', ')}`);
  process.exit(1);
}
console.log('\nALL OK (only GET methods on /api/org-chart/*)');
