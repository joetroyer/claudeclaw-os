#!/usr/bin/env node
/**
 * Slice 7 — Persona Generation Skill
 *
 * Scaffold a new ClaudeClaw agent's directory and launchd plist from a
 * Claude-generated persona, *without* modifying src/agent-create.ts and
 * *without* loading the launchd plist.
 *
 * The skill chain at skills/agent.create/SKILL.md is the authoritative
 * caller. Claude reads that markdown, generates the persona prose, then
 * invokes this CLI with the structured inputs.
 *
 * Usage:
 *   node dist/agent-persona-scaffold.js \
 *     --slug deliverability-expert \
 *     --display-name "Deliverability Expert" \
 *     --description "Inbox placement, DNS auth, sender reputation, and warmup playbooks" \
 *     --persona-file /tmp/agent-persona.md \
 *     --results-json '["inbox placement >95%", "spam complaint rate <0.1%", "auth pass rate >99%"]' \
 *     --skills-json '["gmail", "slack"]' \
 *     --lob "" \
 *     --projects-json '[]' \
 *     [--avatar-source /tmp/agent-avatar.png] \
 *     [--agents-dir /override/agents] \
 *     [--launchd-dir /override/launchd] \
 *     [--dry-run]
 *
 * The persona file is a markdown document that will replace the
 * {{ROLE_PROSE}}, {{RESPONSIBILITIES_BULLETS}}, {{RESULTS_BULLETS}},
 * {{STYLE_PROSE}}, {{REQUIREMENTS_BULLETS}}, and {{BACKSTORY_PARAGRAPH}}
 * placeholders in templates/CLAUDE.md.tpl. The file uses YAML-style
 * front matter to deliver the structured pieces:
 *
 *   ---
 *   role: |
 *     2-3 sentences of prose about what this agent does.
 *   responsibilities:
 *     - thing one
 *     - thing two
 *   results:
 *     - measurable outcome one
 *     - measurable outcome two
 *   style: |
 *     Description of tone / pushback / format. Defaults to house style.
 *   requirements:
 *     - extra hard rule one (appended after the always-applies list)
 *   backstory: |
 *     Single paragraph: hometown, hobbies, beliefs.
 *   ---
 *
 * Anything in the file body after `---` is appended to the CLAUDE.md as-is.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// Resolve PROJECT_ROOT without importing src/config.ts (avoids pulling in
// the full src dependency graph). This file lives at scripts/ in the
// source tree and at dist/ once compiled. Both are one level under root.
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const VALID_ID_RE = /^[a-z][a-z0-9_-]{0,29}$/;

interface CliArgs {
  slug?: string;
  displayName?: string;
  description?: string;
  personaFile?: string;
  resultsJson?: string;
  skillsJson?: string;
  lob?: string;
  projectsJson?: string;
  avatarSource?: string;
  agentsDir?: string;
  launchdDir?: string;
  dryRun?: boolean;
  help?: boolean;
}

interface PersonaData {
  role: string;
  responsibilities: string[];
  results: string[];
  style: string;
  requirements: string[];
  backstory: string;
  /** Anything past the front-matter terminator, appended verbatim. */
  trailingBody: string;
}

const HOUSE_STYLE_PROSE = `Chill, grounded, straight up. Talks like a real person, not a language model.

Lead with the bottom line. Pushes back with data when it disagrees and asks one short clarifying question instead of guessing. Cites sources when accuracy matters and uses tables for comparisons.`;

function usage(): void {
  console.log(`Usage: agent-persona-scaffold --slug SLUG --display-name NAME --description DESC --persona-file PATH [options]

Required:
  --slug SLUG              Agent identifier (lowercase, [a-z0-9_-], 1-30 chars, starts with letter)
  --display-name NAME      Display name shown in dashboard / Telegram
  --description DESC       One-line capability summary
  --persona-file PATH      Markdown file with persona front-matter (see header for shape)

Optional:
  --results-json JSON      JSON array of measurable Four-R results (overrides front matter)
  --skills-json JSON       JSON array of primary skill slugs
  --lob SLUG               Line-of-business slug (Slice 3)
  --projects-json JSON     JSON array of project slugs
  --avatar-source PATH     PNG to copy into agents/<slug>/avatar.png
  --agents-dir DIR         Override the agents/ root (default: <repo>/agents)
  --launchd-dir DIR        Override the launchd/ root (default: <repo>/launchd)
  --dry-run                Print what would be written, don't touch disk
  --help                   Show this help

Behaviour:
  - Validates slug, refuses to overwrite an existing agents/<slug>/ directory.
  - Composes CLAUDE.md from skills/agent.create/templates/CLAUDE.md.tpl.
  - Composes agent.yaml from skills/agent.create/templates/agent.yaml.tpl.
  - Generates launchd/com.claudeclaw.<slug>.plist using the same template
    src/agent-create.ts:generateLaunchdPlist uses (placeholders intact —
    activateAgent substitutes them at bootstrap time).
  - Does NOT load the plist into launchd. Does NOT mutate .env.
  - Does NOT modify src/agent-create.ts.`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const val = argv[++i];
    switch (key) {
      case 'slug': args.slug = val; break;
      case 'display-name': args.displayName = val; break;
      case 'description': args.description = val; break;
      case 'persona-file': args.personaFile = val; break;
      case 'results-json': args.resultsJson = val; break;
      case 'skills-json': args.skillsJson = val; break;
      case 'lob': args.lob = val; break;
      case 'projects-json': args.projectsJson = val; break;
      case 'avatar-source': args.avatarSource = val; break;
      case 'agents-dir': args.agentsDir = val; break;
      case 'launchd-dir': args.launchdDir = val; break;
      default: console.error(`Unknown flag: ${arg}`); process.exit(1);
    }
  }
  return args;
}

function validateSlug(slug: string): string | null {
  if (!slug) return 'slug is required';
  if (!VALID_ID_RE.test(slug)) {
    return 'slug must be lowercase, start with a letter, contain only [a-z0-9_-], max 30 chars';
  }
  if (slug === 'main') return '"main" is reserved for the primary bot';
  if (slug.startsWith('_')) return 'slugs starting with _ are reserved for templates';
  return null;
}

function parsePersonaFile(filePath: string): PersonaData {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Front matter: starts with `---` line, ends with `---` line.
  const trimmed = raw.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) {
    throw new Error(`persona file ${filePath} must start with YAML front matter (--- ... ---)`);
  }
  const closer = trimmed.indexOf('\n---', 3);
  if (closer < 0) {
    throw new Error(`persona file ${filePath} missing front-matter terminator`);
  }
  const fmText = trimmed.slice(3, closer).trim();
  const trailing = trimmed.slice(closer + 4).trim();
  const fm = yaml.load(fmText) as Record<string, unknown> | null;
  if (!fm || typeof fm !== 'object') {
    throw new Error(`persona file ${filePath}: front matter is empty or invalid`);
  }
  const role = (fm['role'] as string | undefined)?.trim() ?? '';
  const responsibilities = Array.isArray(fm['responsibilities'])
    ? (fm['responsibilities'] as unknown[]).map((x) => String(x))
    : [];
  const results = Array.isArray(fm['results'])
    ? (fm['results'] as unknown[]).map((x) => String(x))
    : [];
  const style = (fm['style'] as string | undefined)?.trim() ?? HOUSE_STYLE_PROSE;
  const requirements = Array.isArray(fm['requirements'])
    ? (fm['requirements'] as unknown[]).map((x) => String(x))
    : [];
  const backstory = (fm['backstory'] as string | undefined)?.trim() ?? '';

  if (!role) throw new Error('persona front matter missing required `role`');
  if (responsibilities.length === 0) {
    throw new Error('persona front matter missing required `responsibilities` array');
  }
  if (results.length === 0) {
    throw new Error('persona front matter missing required `results` array');
  }
  if (!backstory) throw new Error('persona front matter missing required `backstory`');

  return {
    role,
    responsibilities,
    results,
    style,
    requirements,
    backstory,
    trailingBody: trailing,
  };
}

function bulletList(items: string[]): string {
  return items.map((s) => `- ${s.trim()}`).join('\n');
}

function renderClaudeMd(
  template: string,
  slug: string,
  displayName: string,
  persona: PersonaData,
): string {
  const requirementsRendered = persona.requirements.length > 0
    ? '\n' + bulletList(persona.requirements)
    : '';

  let out = template
    .replace(/\{\{DISPLAY_NAME\}\}/g, displayName)
    .replace(/\{\{ROLE_PROSE\}\}/g, persona.role)
    .replace(/\{\{RESPONSIBILITIES_BULLETS\}\}/g, bulletList(persona.responsibilities))
    .replace(/\{\{RESULTS_BULLETS\}\}/g, bulletList(persona.results))
    .replace(/\{\{STYLE_PROSE\}\}/g, persona.style)
    .replace(/\{\{REQUIREMENTS_BULLETS\}\}/g, requirementsRendered)
    .replace(/\{\{BACKSTORY_PARAGRAPH\}\}/g, persona.backstory)
    .replace(/\{\{SLUG\}\}/g, slug);

  if (persona.trailingBody) {
    out = out.trimEnd() + '\n\n' + persona.trailingBody + '\n';
  }
  return out;
}

function renderAgentYaml(
  template: string,
  displayName: string,
  description: string,
  tokenEnv: string,
  results: string[],
  skills: string[],
  lob: string,
  projects: string[],
  avatarRelPath: string,
): string {
  // Use yaml.dump with flow style for short arrays, falls back to block.
  const dumpArray = (arr: string[]): string => {
    if (arr.length === 0) return '[]';
    return yaml.dump(arr, { lineWidth: -1 }).trim().split('\n').map((line, i) => {
      // Re-indent for the position in the template (already 4 spaces for results, 4 for skills.primary, 0 for projects).
      return line;
    }).join('\n');
  };
  // Inline (flow style) arrays for empty/non-empty short lists, since
  // the surrounding YAML uses block-aware comments. yaml.dump with
  // flowLevel: 0 produces flow style for everything.
  const flow = (arr: string[]): string =>
    yaml.dump(arr, { flowLevel: 0, lineWidth: -1 }).trim();

  return template
    .replace(/\{\{DISPLAY_NAME\}\}/g, displayName)
    .replace(/\{\{DESCRIPTION\}\}/g, description.replace(/"/g, '\\"'))
    .replace(/\{\{TOKEN_ENV\}\}/g, tokenEnv)
    .replace(/\{\{RESULTS_YAML\}\}/g, flow(results))
    .replace(/\{\{SKILLS_YAML\}\}/g, flow(skills))
    .replace(/\{\{PROJECTS_YAML\}\}/g, flow(projects))
    .replace(/\{\{LOB\}\}/g, lob)
    .replace(/\{\{AVATAR_REL_PATH\}\}/g, avatarRelPath);
}

/**
 * Generate the launchd plist text. Mirrors src/agent-create.ts:generateLaunchdPlist
 * placeholder shape so activateAgent (when the user runs it) substitutes
 * __PROJECT_DIR__, __HOME__, __LOG_DIR__, __CLAUDE_CONFIG_DIR__ correctly.
 *
 * We deliberately use the same node binary path the running process is
 * using — the one that compiled this script — so an activated plist
 * doesn't drift from the parent's PATH.
 */
function buildLaunchdPlist(slug: string): string {
  const label = `com.claudeclaw.${slug}`;
  const nodePath = process.execPath;
  const nodeBinDir = path.dirname(nodePath);
  const systemPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const allPaths = [nodeBinDir, ...systemPaths.filter(p => p !== nodeBinDir)];
  const envPath = allPaths.join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>dist/index.js</string>
    <string>--agent</string>
    <string>${slug}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__PROJECT_DIR__</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>__HOME__</string>
    <key>CLAUDE_CONFIG_DIR</key>
    <string>__CLAUDE_CONFIG_DIR__</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/${slug}.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/${slug}.log</string>
</dict>
</plist>
`;
}

interface ScaffoldResult {
  slug: string;
  agentDir: string;
  claudeMdPath: string;
  yamlPath: string;
  avatarPath: string | null;
  plistPath: string;
  tokenEnv: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }

  const slug = args.slug;
  const slugErr = slug ? validateSlug(slug) : 'slug is required';
  if (slugErr || !slug) { console.error(`error: ${slugErr}`); process.exit(1); }

  const displayName = args.displayName;
  const description = args.description;
  const personaFilePath = args.personaFile;
  if (!displayName) { console.error('error: --display-name required'); process.exit(1); }
  if (!description) { console.error('error: --description required'); process.exit(1); }
  if (!personaFilePath) { console.error('error: --persona-file required'); process.exit(1); }
  if (!fs.existsSync(personaFilePath)) {
    console.error(`error: persona file not found: ${personaFilePath}`); process.exit(1);
  }

  const persona = parsePersonaFile(personaFilePath);
  // CLI flags override front-matter values for the structured arrays.
  const results = args.resultsJson ? (JSON.parse(args.resultsJson) as string[]) : persona.results;
  const skills = args.skillsJson ? (JSON.parse(args.skillsJson) as string[]) : [];
  const projects = args.projectsJson ? (JSON.parse(args.projectsJson) as string[]) : [];
  const lob = args.lob ?? '';

  const agentsRoot = args.agentsDir ?? path.join(PROJECT_ROOT, 'agents');
  const launchdRoot = args.launchdDir ?? path.join(PROJECT_ROOT, 'launchd');
  const agentDir = path.join(agentsRoot, slug);

  if (fs.existsSync(agentDir)) {
    console.error(`error: agent directory already exists: ${agentDir}`); process.exit(1);
  }

  // Read templates (next to this script in the skill dir, regardless of
  // whether we're running from src/ or dist/).
  const tplDir = path.join(PROJECT_ROOT, 'skills', 'agent.create', 'templates');
  const claudeMdTpl = fs.readFileSync(path.join(tplDir, 'CLAUDE.md.tpl'), 'utf-8');
  const yamlTpl = fs.readFileSync(path.join(tplDir, 'agent.yaml.tpl'), 'utf-8');

  const tokenEnv = `${slug.toUpperCase().replace(/-/g, '_')}_BOT_TOKEN`;
  const avatarRelPath = `agents/${slug}/avatar.png`;

  const claudeMd = renderClaudeMd(claudeMdTpl, slug, displayName, {
    ...persona,
    results,
  });
  const agentYaml = renderAgentYaml(
    yamlTpl,
    displayName,
    description,
    tokenEnv,
    results,
    skills,
    lob,
    projects,
    avatarRelPath,
  );
  const plistText = buildLaunchdPlist(slug);

  const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
  const yamlPath = path.join(agentDir, 'agent.yaml');
  const avatarPath = path.join(agentDir, 'avatar.png');
  const plistPath = path.join(launchdRoot, `com.claudeclaw.${slug}.plist`);

  if (args.dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      slug,
      agentDir,
      files: {
        claudeMd: claudeMdPath,
        yaml: yamlPath,
        avatar: avatarPath,
        plist: plistPath,
      },
      tokenEnv,
      claudeMdPreview: claudeMd.slice(0, 400) + '...',
      yamlPreview: agentYaml,
    }, null, 2));
    return;
  }

  // Write
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(launchdRoot, { recursive: true });
  fs.writeFileSync(claudeMdPath, claudeMd, 'utf-8');
  fs.writeFileSync(yamlPath, agentYaml, 'utf-8');
  fs.writeFileSync(plistPath, plistText, 'utf-8');

  let avatarOut: string | null = null;
  if (args.avatarSource) {
    if (!fs.existsSync(args.avatarSource)) {
      console.error(`warning: avatar source missing, skipping copy: ${args.avatarSource}`);
    } else {
      fs.copyFileSync(args.avatarSource, avatarPath);
      avatarOut = avatarPath;
    }
  }

  const result: ScaffoldResult = {
    slug,
    agentDir,
    claudeMdPath,
    yamlPath,
    avatarPath: avatarOut,
    plistPath,
    tokenEnv,
  };
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nNext steps:
  1. Add Telegram bot token to .env:
       ${tokenEnv}=<token-from-@BotFather>
  2. To start the agent (REQUIRES YOUR EXPLICIT CONFIRMATION):
       launchctl bootstrap gui/$(id -u) ${plistPath}
     (the plist still has __PROJECT_DIR__ / __HOME__ placeholders — running it through
      src/agent-create.ts:activateAgent will substitute them, OR copy + sed manually.)`);
}

main().catch((err) => {
  console.error('agent-persona-scaffold failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
