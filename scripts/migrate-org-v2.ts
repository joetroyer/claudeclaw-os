#!/usr/bin/env tsx
/**
 * Slice 10 Wave 0 — Org Chart V2 schema migration.
 *
 * Walks every agent.yaml (and agent.yaml.example) under agents/ and
 * appends two new top-level keys if they're missing:
 *
 *   type: "ai"          # "ai" | "human" — drives OrgChartV2 card badge
 *   reports_to: "<id>"  # name (id) of parent node — drives chart edges
 *
 * Also patches humans.yaml so each entry gains:
 *
 *   type: "human"
 *   reports_to: "<id>"  # "" for the root (Joe), "joe" for Ali
 *
 * Idempotent — re-running adds nothing if the keys already exist.
 * Existing fields, comments, and key order are left bit-identical
 * because we work on the raw text rather than round-tripping through
 * yaml.dump.
 *
 * The reports_to tree shipped here matches Slice 10's "AI-as-head"
 * model from the Obsidian note "LinkedIn — I Have 150 AI Employees":
 *
 *   joe (Human · Founder & Operator)
 *   ├── meta (AI · Chief of Staff)             reports_to: joe
 *   │   ├── content (AI · Director of Content)    reports_to: meta
 *   │   ├── research (AI · Director of Research)  reports_to: meta
 *   │   ├── ops (AI · Director of Operations)     reports_to: meta
 *   │   ├── comms (AI · Director of Comms)        reports_to: meta
 *   │   └── clawds (AI · Google Ads Specialist)   reports_to: meta
 *   ├── trading-monitor (AI · Trading Desk Lead)  reports_to: joe
 *   └── goldbot-labs (AI · Lab Researcher)        reports_to: joe
 *
 * Rationale for the clawds → meta edge (vs clawds → joe): clawds is an
 * agency-LOB specialist working on client deliverables. Meta is the
 * Chief of Staff for client-facing work. Trading-desk and lab agents
 * are direct Joe-owned operations and stay one level up.
 *
 * If an agent.yaml has no obvious place in the tree (e.g. a fresh
 * worker template), it falls back to reports_to: "joe" — safe default
 * because Joe is always root.
 *
 * Usage:
 *   tsx scripts/migrate-org-v2.ts                  # default <repo>
 *   tsx scripts/migrate-org-v2.ts --dry-run        # report only
 *   tsx scripts/migrate-org-v2.ts --root <path>    # custom repo root
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');

interface CliArgs {
  root: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let dryRun = false;
  let root = DEFAULT_ROOT;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run' || a === '-n') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--root') {
      const next = args[i + 1];
      if (!next) {
        console.error('--root requires a path argument');
        process.exit(1);
      }
      root = path.resolve(next);
      i += 1;
    } else if (!a.startsWith('-')) {
      // Positional repo root, kept for parity with migrate-agent-schema.ts.
      root = path.resolve(a);
    }
  }
  return { root, dryRun };
}

function printHelp() {
  console.log('Usage: tsx scripts/migrate-org-v2.ts [<repo-root>] [--dry-run]');
  console.log('');
  console.log('Default repo-root: <this-repo>');
  console.log('Walks <root>/agents/*/agent.yaml{,.example} and patches');
  console.log('<root>/humans.yaml. Idempotent — safe to re-run.');
}

/** Reports-to assignments for the production agents we know about.
 *  Anything not in this map falls back to "joe". The list is small on
 *  purpose — keep this aligned with `agents/schema.md` and the Wave 0
 *  org-tree-decisions doc. */
const REPORTS_TO_BY_AGENT_ID: Record<string, string> = {
  meta: 'joe',
  content: 'meta',
  research: 'meta',
  ops: 'meta',
  comms: 'meta',
  clawds: 'meta',
  'trading-monitor': 'joe',
  'goldbot-labs': 'joe',
};

const FALLBACK_REPORTS_TO = 'joe';

interface AgentFileResult {
  path: string;
  agentId: string;
  alreadyHadAll: boolean;
  added: string[];
  bytesBefore: number;
  bytesAfter: number;
  written: boolean;
}

/** Top-level keys present in the YAML. Used to decide which keys to
 *  append. We parse — comments and whitespace are irrelevant. */
function topLevelKeys(text: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    throw new Error(`YAML parse failed: ${(err as Error).message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Set();
  }
  return new Set(Object.keys(parsed as Record<string, unknown>));
}

/** Pick reports_to for a given agent dir name. Production agents have
 *  hard-coded edges; anything else (including the _template) falls back
 *  to "joe" — safe default. */
function pickReportsTo(agentId: string): string {
  return REPORTS_TO_BY_AGENT_ID[agentId] ?? FALLBACK_REPORTS_TO;
}

function migrateAgentYaml(filePath: string, dryRun: boolean): AgentFileResult {
  const before = fs.readFileSync(filePath, 'utf-8');
  const present = topLevelKeys(before);
  // Agent id is the parent dir name. _template / agent.yaml.example also
  // get patched so new agents start with the new fields wired up.
  const agentId = path.basename(path.dirname(filePath));

  const added: string[] = [];
  if (!present.has('type')) added.push('type');
  if (!present.has('reports_to')) added.push('reports_to');

  if (added.length === 0) {
    return {
      path: filePath,
      agentId,
      alreadyHadAll: true,
      added,
      bytesBefore: before.length,
      bytesAfter: before.length,
      written: false,
    };
  }

  const reportsTo = pickReportsTo(agentId);

  const sectionHeader =
`\n\n# ────────────────────────────────────────────────────────────────────
# Slice 10 Wave 0 — Org Chart V2 (added by scripts/migrate-org-v2.ts).
# Additive only. Drives the new /api/org-chart-v2 endpoint and the
# OrgChartV2 page. The Slice 3 /api/org-chart/* endpoints ignore these.
# ────────────────────────────────────────────────────────────────────
`;

  const blocks: string[] = [];
  if (added.includes('type')) {
    blocks.push(
`# Slice 10: node type for the org chart — "ai" or "human".
# Every agent.yaml is "ai"; humans live in humans.yaml.
type: "ai"
`,
    );
  }
  if (added.includes('reports_to')) {
    blocks.push(
`# Slice 10: id of the parent node on the org chart. Empty string (or
# omitted) means "root" — only Joe should ever be root. AI nodes may
# occupy any tier, so this can point at another AI (e.g. "meta") or a
# human id from humans.yaml.
reports_to: "${reportsTo}"
`,
    );
  }

  const trimmed = before.replace(/\s+$/u, '');
  const after = `${trimmed}${sectionHeader}\n${blocks.join('\n')}`;

  // Round-trip check — guarantees we didn't break parsing.
  try {
    yaml.load(after);
  } catch (err) {
    throw new Error(`Post-migration YAML parse failed for ${filePath}: ${(err as Error).message}`);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, after, 'utf-8');
  }

  return {
    path: filePath,
    agentId,
    alreadyHadAll: false,
    added,
    bytesBefore: before.length,
    bytesAfter: after.length,
    written: !dryRun,
  };
}

function findAgentYamlFiles(agentsDir: string): string[] {
  if (!fs.existsSync(agentsDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subdir = path.join(agentsDir, entry.name);
    for (const fname of fs.readdirSync(subdir)) {
      if (fname === 'agent.yaml' || fname === 'agent.yaml.example') {
        out.push(path.join(subdir, fname));
      }
    }
  }
  return out.sort();
}

// ── humans.yaml patching ───────────────────────────────────────────────

interface HumansResult {
  path: string;
  exists: boolean;
  alreadyHadAll: boolean;
  patchedEntries: { id: string; added: string[] }[];
  bytesBefore: number;
  bytesAfter: number;
  written: boolean;
}

/** Default reports_to for known human ids. "" means root. Joe is the
 *  only root in production; Ali reports to Joe per Slice 3 + the
 *  Wave-0 org tree. Anything else falls back to "joe" so a new
 *  human entry without a documented edge slots in safely. */
const REPORTS_TO_BY_HUMAN_ID: Record<string, string> = {
  joe: '',
  ali: 'joe',
};
const FALLBACK_HUMAN_REPORTS_TO = 'joe';

function pickReportsToForHuman(humanId: string): string {
  return humanId in REPORTS_TO_BY_HUMAN_ID
    ? REPORTS_TO_BY_HUMAN_ID[humanId]
    : FALLBACK_HUMAN_REPORTS_TO;
}

/** Patch humans.yaml in place, adding `type: "human"` and (optionally)
 *  `reports_to:` per entry. Done by string-walking the file rather than
 *  yaml.dump'ing so existing comments + key order are preserved. */
function migrateHumansYaml(filePath: string, dryRun: boolean): HumansResult {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      alreadyHadAll: true,
      patchedEntries: [],
      bytesBefore: 0,
      bytesAfter: 0,
      written: false,
    };
  }

  const before = fs.readFileSync(filePath, 'utf-8');
  const lines = before.split('\n');

  // Find each `- id: <id>` entry in the humans: list and inspect the
  // contiguous block of `    <key>: <val>` lines that follow it. We use
  // the same indentation the seed file uses (2-space list dash, 4-space
  // child keys). If a project ever switches indentation styles we'll
  // need to revisit.
  const entries: {
    id: string;
    startLine: number;       // line index of `- id:`
    endLine: number;         // line index of last child key in entry (inclusive)
    indent: string;          // child-key indent (e.g. "    ")
    hasType: boolean;
    hasReportsTo: boolean;
  }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*-)\s+id:\s*(\S+)\s*$/);
    if (!m) continue;
    const dashIndent = m[1]; // e.g. "  -"
    const id = m[2].replace(/['"]/g, '');
    // Child keys are indented further than the `- id:` line.
    const childIndent = ' '.repeat(dashIndent.length + 2 - 1); // matches "    " when dashIndent = "  -"
    let endLine = i;
    let hasType = false;
    let hasReportsTo = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const ln = lines[j];
      // Blank line or new dash → end of this entry.
      if (/^\s*-\s+id:/.test(ln)) break;
      if (ln.trim() === '') {
        // Allow internal blank lines, but they end the contiguous block
        // we'll splice into. We want to insert BEFORE the blank line.
        break;
      }
      // Top-level key (no leading whitespace) → also end of list.
      if (/^[^\s]/.test(ln)) break;
      if (ln.startsWith(childIndent)) {
        endLine = j;
        const km = ln.match(/^\s+([a-z_]+)\s*:/);
        if (km) {
          if (km[1] === 'type') hasType = true;
          if (km[1] === 'reports_to') hasReportsTo = true;
        }
      } else {
        break;
      }
    }
    entries.push({ id, startLine: i, endLine, indent: childIndent, hasType, hasReportsTo });
  }

  // Already up-to-date if every entry has both fields.
  const allDone = entries.every((e) => e.hasType && e.hasReportsTo);
  if (allDone) {
    return {
      path: filePath,
      exists: true,
      alreadyHadAll: true,
      patchedEntries: [],
      bytesBefore: before.length,
      bytesAfter: before.length,
      written: false,
    };
  }

  // Walk in reverse so splicing doesn't shift earlier line indices.
  let workingLines = [...lines];
  const patched: { id: string; added: string[] }[] = [];
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    const e = entries[k];
    const additions: string[] = [];
    const insertLines: string[] = [];
    if (!e.hasType) {
      additions.push('type');
      insertLines.push(`${e.indent}type: "human"`);
    }
    if (!e.hasReportsTo) {
      const rt = pickReportsToForHuman(e.id);
      additions.push('reports_to');
      insertLines.push(`${e.indent}reports_to: "${rt}"`);
    }
    if (additions.length === 0) continue;
    // Insert immediately AFTER the last child line of this entry.
    workingLines.splice(e.endLine + 1, 0, ...insertLines);
    patched.push({ id: e.id, added: additions });
  }

  const after = workingLines.join('\n');

  // Round-trip check.
  try {
    yaml.load(after);
  } catch (err) {
    throw new Error(`Post-migration YAML parse failed for ${filePath}: ${(err as Error).message}`);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, after, 'utf-8');
  }

  return {
    path: filePath,
    exists: true,
    alreadyHadAll: false,
    patchedEntries: patched.reverse(),
    bytesBefore: before.length,
    bytesAfter: after.length,
    written: !dryRun,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const ts = new Date().toISOString();
  console.log(`[migrate-org-v2] start ${ts}`);
  console.log(`[migrate-org-v2] repo root: ${args.root}`);
  if (args.dryRun) console.log(`[migrate-org-v2] dry-run: no files will be written`);

  const agentsDir = path.join(args.root, 'agents');
  if (!fs.existsSync(agentsDir)) {
    console.error(`[migrate-org-v2] ERROR: agents dir not found: ${agentsDir}`);
    process.exit(1);
  }

  const files = findAgentYamlFiles(agentsDir);
  if (files.length === 0) {
    console.log(`[migrate-org-v2] no agent.yaml(.example) files found under ${agentsDir}`);
  }

  let mutated = 0;
  let alreadyDone = 0;
  for (const f of files) {
    try {
      const r = migrateAgentYaml(f, args.dryRun);
      const rel = path.relative(args.root, r.path);
      if (r.alreadyHadAll) {
        alreadyDone += 1;
        console.log(`  ok    ${rel}  (type + reports_to already present)`);
      } else {
        mutated += 1;
        const verb = r.written ? 'wrote' : 'would-write';
        const reportsTo = pickReportsTo(r.agentId);
        console.log(`  ${verb} ${rel}  (+${r.added.length}: ${r.added.join(', ')}; reports_to="${reportsTo}")`);
      }
    } catch (err) {
      console.error(`  ERROR ${f}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  // humans.yaml
  const humansPath = path.join(args.root, 'humans.yaml');
  console.log('');
  let humansResult: HumansResult;
  try {
    humansResult = migrateHumansYaml(humansPath, args.dryRun);
    const relH = path.relative(args.root, humansPath);
    if (!humansResult.exists) {
      console.log(`  --    ${relH}  (file not present; skipping)`);
    } else if (humansResult.alreadyHadAll) {
      console.log(`  ok    ${relH}  (every entry already has type + reports_to)`);
    } else {
      const verb = humansResult.written ? 'wrote' : 'would-write';
      const summary = humansResult.patchedEntries
        .map((p) => `${p.id}(+${p.added.join(',')})`)
        .join(' ');
      console.log(`  ${verb} ${relH}  (${summary})`);
    }
  } catch (err) {
    console.error(`  ERROR ${humansPath}: ${(err as Error).message}`);
    process.exitCode = 1;
  }

  console.log('');
  console.log(`[migrate-org-v2] agent files scanned: ${files.length}`);
  console.log(`[migrate-org-v2] agent files migrated: ${mutated}`);
  console.log(`[migrate-org-v2] agent files already up-to-date: ${alreadyDone}`);
  console.log(`[migrate-org-v2] done ${new Date().toISOString()}`);
}

try {
  main();
} catch (err) {
  console.error(`[migrate-org-v2] ERROR: ${(err as Error).message}`);
  process.exit(1);
}
