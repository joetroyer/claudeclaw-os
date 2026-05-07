#!/usr/bin/env tsx
/**
 * Slice 1 — Agent Schema Upgrade migration.
 *
 * Walks every agent.yaml (and agent.yaml.example) under agents/ and
 * appends the Slice-1 schema additions if they're missing. Idempotent —
 * re-running adds nothing if the keys already exist. Existing fields,
 * comments, and key order are left bit-identical because we work on the
 * raw text rather than round-tripping through yaml.dump.
 *
 * What we add (additive only — see agentic-os-integration-plan.md §Slice 1):
 *   four_rs.results
 *   owns.scheduled_tasks / triggered_tasks / n8n_workflows / watchers
 *   lob, projects, ideal
 *   platform
 *   skills.primary
 *   avatar
 *
 * What we DO NOT add (these live in CLAUDE.md prose, never YAML):
 *   role, responsibilities, requirements, personality.*, backstory
 *
 * Usage:
 *   tsx scripts/migrate-agent-schema.ts            # walks <repo>/agents
 *   tsx scripts/migrate-agent-schema.ts <dir>      # walks a specific dir
 *   tsx scripts/migrate-agent-schema.ts --dry-run  # report only, no writes
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface CliArgs {
  dir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let dryRun = false;
  let dir = path.join(PROJECT_ROOT, 'agents');
  for (const a of args) {
    if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('-')) {
      dir = path.resolve(a);
    }
  }
  return { dir, dryRun };
}

function printHelp() {
  console.log('Usage: tsx scripts/migrate-agent-schema.ts [agents-dir] [--dry-run]');
  console.log('');
  console.log('Default agents-dir: <repo>/agents');
  console.log('Idempotent — safe to run repeatedly.');
}

/** Block of YAML appended when a top-level key is missing. Keep the
 *  text shape stable so the diff on first migration is minimal and
 *  visually inspectable. */
const APPENDIX: Record<string, string> = {
  four_rs:
`# Slice 1 (vision5-7-2026): measurable outcomes for the Four Rs.
# role / responsibilities / requirements live in CLAUDE.md as prose.
four_rs:
  results: []
`,
  owns:
`# Slice 1: ownership pointers — scheduled tasks, triggered (webhook)
# tasks, n8n workflows, watchers.yaml entries this agent is responsible
# for. Used by Slices 3 (org chart) and 4 (n8n auto-tasks).
owns:
  scheduled_tasks: []
  triggered_tasks: []
  n8n_workflows: []
  watchers: []
`,
  lob:
`# Slice 1: line of business this agent rolls up to (used by Slice 3
# org chart). Empty until lobs.yaml is populated in Slice 3.
lob: ""
`,
  projects:
`# Slice 1: projects this agent is assigned to (used by Slice 3).
projects: []
`,
  ideal:
`# Slice 1: ideal=true means this agent is mapped on the org chart but
# not yet built (Slice 3 "Ideal vs Active" tab).
ideal: false
`,
  platform:
`# Slice 1: platform routing — claude | openai | gemini | openrouter | subscription.
# Used by Slice 5 cost rollups (subscription = $0 with badge).
platform: ""
`,
  skills:
`# Slice 1: primary skills this agent leans on. All other skills remain
# implicitly available — this is a hint, not an allowlist.
skills:
  primary: []
`,
  avatar:
`# Slice 1: avatar path or URL. Populated by Slice 7 persona generator.
avatar: ""
`,
};

const NEW_TOP_LEVEL_KEYS = Object.keys(APPENDIX);

interface FileResult {
  path: string;
  alreadyHadAll: boolean;
  added: string[];
  skipped: string[];
  bytesBefore: number;
  bytesAfter: number;
  written: boolean;
}

/** Top-level keys present in the YAML. We use a parsed view for the
 *  presence check — comments and inline whitespace are irrelevant. */
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

function migrateFile(filePath: string, dryRun: boolean): FileResult {
  const before = fs.readFileSync(filePath, 'utf-8');
  const present = topLevelKeys(before);

  const added: string[] = [];
  const skipped: string[] = [];

  for (const key of NEW_TOP_LEVEL_KEYS) {
    if (present.has(key)) skipped.push(key);
    else added.push(key);
  }

  if (added.length === 0) {
    return {
      path: filePath,
      alreadyHadAll: true,
      added,
      skipped,
      bytesBefore: before.length,
      bytesAfter: before.length,
      written: false,
    };
  }

  // Build the appendix. Ensure exactly one blank line between the
  // existing content and our additions, regardless of trailing
  // whitespace in the original file.
  const trimmed = before.replace(/\s+$/u, '');
  const sectionHeader =
`\n\n# ────────────────────────────────────────────────────────────────────
# Slice 1 — Agent Schema Upgrade (added by scripts/migrate-agent-schema.ts).
# Additive only. Persona prose (role / responsibilities / personality /
# backstory) lives in CLAUDE.md, not here.
# ────────────────────────────────────────────────────────────────────
`;
  const appended = added.map((k) => APPENDIX[k]).join('\n');
  const after = `${trimmed}${sectionHeader}\n${appended}`;

  // Sanity: round-trip the new YAML to confirm we didn't break parsing.
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
    alreadyHadAll: false,
    added,
    skipped,
    bytesBefore: before.length,
    bytesAfter: after.length,
    written: !dryRun,
  };
}

function findYamlFiles(agentsDir: string): string[] {
  // Caller (`main`) handles the missing-dir / not-a-dir cases up front so
  // it can emit a friendly error and exit non-zero without a stack trace.
  // We still defensively re-check here so direct callers don't stat a
  // bogus path.
  if (!fs.existsSync(agentsDir)) {
    throw new Error(`agents directory not found: ${agentsDir}`);
  }
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

/** Validate that the requested target is a real directory. Returns null on
 *  success, or a short user-facing error string on failure. Used by `main`
 *  so a bad CLI argument exits cleanly with a non-zero status instead of
 *  blowing up with an uncaught exception + stack trace. */
function validateTargetDir(dir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') {
      return `Directory not found: ${dir}`;
    }
    if (e && e.code === 'EACCES') {
      return `Permission denied reading directory: ${dir}`;
    }
    return `Cannot access directory: ${dir} (${(err as Error).message})`;
  }
  if (!stat.isDirectory()) {
    return `Not a directory: ${dir}`;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  const ts = new Date().toISOString();
  console.log(`[migrate-agent-schema] start ${ts}`);
  console.log(`[migrate-agent-schema] agents dir: ${args.dir}`);
  if (args.dryRun) console.log(`[migrate-agent-schema] dry-run: no files will be written`);

  const dirError = validateTargetDir(args.dir);
  if (dirError) {
    console.error(`[migrate-agent-schema] ERROR: ${dirError}`);
    process.exit(1);
  }

  const files = findYamlFiles(args.dir);
  if (files.length === 0) {
    console.log(`[migrate-agent-schema] no agent.yaml(.example) files found`);
    return;
  }

  let mutated = 0;
  let alreadyDone = 0;
  for (const f of files) {
    try {
      const r = migrateFile(f, args.dryRun);
      const rel = path.relative(args.dir, r.path);
      if (r.alreadyHadAll) {
        alreadyDone += 1;
        console.log(`  ok    ${rel}  (all Slice-1 keys already present)`);
      } else {
        mutated += 1;
        const verb = r.written ? 'wrote' : 'would-write';
        console.log(`  ${verb} ${rel}  (+${r.added.length} keys: ${r.added.join(', ')}; skipped existing: ${r.skipped.join(', ') || 'none'})`);
      }
    } catch (err) {
      console.error(`  ERROR ${f}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  console.log('');
  console.log(`[migrate-agent-schema] files scanned:  ${files.length}`);
  console.log(`[migrate-agent-schema] files migrated: ${mutated}`);
  console.log(`[migrate-agent-schema] already up-to-date: ${alreadyDone}`);
  console.log(`[migrate-agent-schema] done ${new Date().toISOString()}`);
}

try {
  main();
} catch (err) {
  // Last-resort guard: any uncaught throw (e.g. from `findYamlFiles` if
  // the dir disappears mid-run) prints a clean message and exits non-zero
  // instead of dumping a stack trace.
  console.error(`[migrate-agent-schema] ERROR: ${(err as Error).message}`);
  process.exit(1);
}
