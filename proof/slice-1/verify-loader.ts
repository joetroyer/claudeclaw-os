/**
 * Slice 1 — verify-loader
 *
 * Acceptance criterion from the integration plan:
 *   "agent-config.ts re-loads every migrated YAML and reports it valid."
 *
 * Approach: drive the *real* `loadAgentConfig` from `src/agent-config.ts`
 * against a fixture directory built from every migrated
 * `agents/<id>/agent.yaml.example` in this worktree.
 *
 * Why a fixture: the loader hardcodes the filename `agent.yaml` (not
 * `.example`) and demands a real bot token in env. The migration touched
 * `.example` files, so we copy each one to a temp
 * `<tmp>/agents/<id>/agent.yaml`, stub the matching `*_BOT_TOKEN` env var
 * with a placeholder value, point `CLAUDECLAW_CONFIG` at the temp dir,
 * and call `loadAgentConfig`. We do NOT modify `src/agent-config.ts`.
 *
 * Output: one "OK: <id>" per agent and a final "ALL OK" or
 * "FAILED on N agents". Exits non-zero on any failure.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// proof/slice-1/verify-loader.ts → ../../  is the worktree root.
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(WORKTREE_ROOT, 'agents');

interface AgentFixture {
  id: string;
  examplePath: string;
  tokenEnv: string;
}

function discoverFixtures(): AgentFixture[] {
  const out: AgentFixture[] = [];
  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // We deliberately include `_template` here. The migration writes to
    // `agents/_template/agent.yaml.example`, and the integration-plan
    // acceptance bar is "loader re-loads *every migrated YAML*". The
    // loader's directory-scan helper (`listAgentIds`) excludes underscore
    // dirs by convention, but `loadAgentConfig` itself has no such
    // restriction — calling it directly on `_template` is valid.
    const examplePath = path.join(AGENTS_DIR, entry.name, 'agent.yaml.example');
    if (!fs.existsSync(examplePath)) continue;
    const parsed = yaml.load(fs.readFileSync(examplePath, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`unparseable example file: ${examplePath}`);
    }
    const tokenEnv = parsed['telegram_bot_token_env'] as string | undefined;
    if (!tokenEnv) {
      throw new Error(`example file missing telegram_bot_token_env: ${examplePath}`);
    }
    out.push({ id: entry.name, examplePath, tokenEnv });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function buildFixtureRoot(fixtures: AgentFixture[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice1-verify-loader-'));
  const agentsRoot = path.join(root, 'agents');
  fs.mkdirSync(agentsRoot, { recursive: true });
  for (const fx of fixtures) {
    const dst = path.join(agentsRoot, fx.id);
    fs.mkdirSync(dst, { recursive: true });
    // Copy the migrated .example to agent.yaml so the loader (which only
    // reads `agent.yaml`) sees it. Bit-identical content; no rewrite.
    fs.copyFileSync(fx.examplePath, path.join(dst, 'agent.yaml'));
  }
  return root;
}

async function main(): Promise<void> {
  const fixtures = discoverFixtures();
  if (fixtures.length === 0) {
    console.error('FAIL: no migrated agent.yaml.example files found under agents/');
    process.exit(1);
  }

  const fixtureRoot = buildFixtureRoot(fixtures);

  // Critical: CLAUDECLAW_CONFIG is captured at module-load time inside
  // src/config.ts. Set it BEFORE the dynamic import below or the loader
  // will resolve to the user's real ~/.claudeclaw or repo agents/.
  process.env.CLAUDECLAW_CONFIG = fixtureRoot;
  for (const fx of fixtures) {
    // Stub a non-empty token; the loader only checks truthiness.
    process.env[fx.tokenEnv] = `verify-loader-stub-${fx.id}`;
  }

  // Dynamic import so the env vars above are visible to the module
  // initializers in src/config.ts and src/agent-config.ts.
  const mod = await import(path.join(WORKTREE_ROOT, 'src', 'agent-config.ts'));
  const loadAgentConfig = mod.loadAgentConfig as (id: string) => unknown;
  if (typeof loadAgentConfig !== 'function') {
    console.error('FAIL: src/agent-config.ts does not export loadAgentConfig');
    process.exit(1);
  }

  let failed = 0;
  for (const fx of fixtures) {
    try {
      const cfg = loadAgentConfig(fx.id) as {
        name?: string;
        botToken?: string;
        botTokenEnv?: string;
      };
      // Sanity: confirm the loader actually parsed the YAML and
      // produced the expected shape — not just returned a default.
      if (!cfg || !cfg.name || cfg.botTokenEnv !== fx.tokenEnv) {
        throw new Error(
          `loader returned unexpected shape: name=${cfg?.name} botTokenEnv=${cfg?.botTokenEnv}`,
        );
      }
      console.log(`OK: ${fx.id}`);
    } catch (err) {
      console.log(`FAIL: ${fx.id} — ${(err as Error).message}`);
      failed += 1;
    }
  }

  // Best-effort cleanup of the fixture dir.
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* noop */
  }

  if (failed === 0) {
    console.log(`ALL OK (${fixtures.length} agents loaded via src/agent-config.ts)`);
    process.exit(0);
  } else {
    console.log(`FAILED on ${failed} agents`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
});
