import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SkillMeta {
  id: string;           // directory name
  name: string;         // from frontmatter or first H1
  description: string;  // first paragraph or frontmatter description
  triggerWords: string[]; // from frontmatter 'triggers:' field or derived from name
  fullPath: string;     // absolute path to SKILL.md
  source: 'project' | 'global'; // which directory the skill was loaded from
}

// ── Internal state ──────────────────────────────────────────────────

let skills: Map<string, SkillMeta> = new Map();

// Active fs.watch handles + debounce timer. Held at module scope so a
// second initSkillRegistry() call (e.g. tests, hot reload) can tear the
// previous watchers down before installing new ones.
const activeWatchers: fs.FSWatcher[] = [];
let rescanTimer: NodeJS.Timeout | null = null;

// ── Frontmatter parsing ─────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();
  const fm: Frontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (key === 'name') {
      fm.name = rawValue.replace(/^["']|["']$/g, '');
    } else if (key === 'description') {
      fm.description = rawValue.replace(/^["']|["']$/g, '');
    } else if (key === 'triggers') {
      // triggers can be a comma-separated list or a YAML array on one line
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        fm.triggers = rawValue
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
          .filter(Boolean);
      } else if (rawValue) {
        fm.triggers = rawValue
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
          .filter(Boolean);
      }
    }
  }

  // Handle multi-line triggers (YAML list with - items)
  if (!fm.triggers) {
    const triggersIdx = yamlBlock.indexOf('triggers:');
    if (triggersIdx !== -1) {
      const afterTriggers = yamlBlock.slice(triggersIdx + 'triggers:'.length);
      const firstLineValue = afterTriggers.split('\n')[0].trim();
      if (!firstLineValue) {
        // Multi-line YAML list
        const items: string[] = [];
        const lines = afterTriggers.split('\n').slice(1);
        for (const l of lines) {
          const trimmedLine = l.trim();
          if (trimmedLine.startsWith('- ')) {
            items.push(trimmedLine.slice(2).trim().replace(/^["']|["']$/g, '').toLowerCase());
          } else {
            break;
          }
        }
        if (items.length > 0) fm.triggers = items;
      }
    }
  }

  return { frontmatter: fm, body };
}

function extractFirstH1(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function extractFirstParagraph(body: string): string {
  const lines = body.split('\n');
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headings and empty lines at the start
    if (!started) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      started = true;
    }
    if (started) {
      if (!trimmed) break;
      if (trimmed.startsWith('#')) break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(' ').slice(0, 200);
}

// ── Skill scanning ──────────────────────────────────────────────────

function findSkillFile(dir: string): string | null {
  const skillMd = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMd)) return skillMd;

  // Fall back to first .md file
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        return path.join(dir, entry.name);
      }
    }
  } catch {
    // Directory not readable
  }
  return null;
}

function scanDirectoryInto(
  dir: string,
  source: 'project' | 'global',
  target: Map<string, SkillMeta>,
): void {
  if (!fs.existsSync(dir)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    logger.warn({ dir }, 'Could not read skill directory');
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const skillDir = path.join(dir, entry.name);
    const skillFile = findSkillFile(skillDir);
    if (!skillFile) continue;

    let content: string;
    try {
      content = fs.readFileSync(skillFile, 'utf-8');
    } catch {
      logger.warn({ skillFile }, 'Could not read skill file');
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const name = frontmatter.name || extractFirstH1(body) || entry.name;
    const description = frontmatter.description || extractFirstParagraph(body);
    const triggerWords = frontmatter.triggers
      || name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

    const meta: SkillMeta = {
      id: entry.name,
      name,
      description,
      triggerWords,
      fullPath: skillFile,
      source,
    };

    // Don't overwrite if already registered (project skills take priority)
    if (!target.has(meta.id)) {
      target.set(meta.id, meta);
    }
  }
}

/**
 * Scan both skill roots into a fresh Map and atomically swap it in. Used
 * by initSkillRegistry() and by the fs.watch debounce after a change.
 */
function rescanAll(projectSkillsDir: string, globalSkillsDir: string): void {
  const next = new Map<string, SkillMeta>();
  // Scan project skills first (they take priority).
  scanDirectoryInto(projectSkillsDir, 'project', next);
  scanDirectoryInto(globalSkillsDir, 'global', next);
  // Atomic swap — no readers ever see a half-built map.
  skills = next;
}

// ── File-system watchers ────────────────────────────────────────────

function teardownWatchers(): void {
  if (rescanTimer) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }
  for (const w of activeWatchers) {
    try { w.close(); } catch { /* already closed */ }
  }
  activeWatchers.length = 0;
}

/**
 * Wire fs.watch on both skill roots so a newly added (or removed) SKILL.md
 * appears in /api/skills without restarting the dashboard. Handles the
 * common failure modes:
 *   - Directory doesn't exist on this host (~/.claude/skills not present):
 *     skip silently. We do NOT poll-create — boot stays cheap.
 *   - Directory exists but isn't watchable (EACCES, EPERM, EBUSY): log a
 *     warn and continue without that watcher.
 *   - Recursive watch unsupported on the platform (very old Node, BSDs):
 *     fall back to a non-recursive watch on the root only; new skill dirs
 *     still trigger because their creation is a change in the parent.
 */
function installWatchers(projectSkillsDir: string, globalSkillsDir: string): void {
  const targets: { dir: string; source: 'project' | 'global' }[] = [
    { dir: projectSkillsDir, source: 'project' },
    { dir: globalSkillsDir, source: 'global' },
  ];

  for (const { dir, source } of targets) {
    if (!fs.existsSync(dir)) {
      // Skip — no point watching a path that doesn't exist on this host.
      // If the user creates ~/.claude/skills later they'll need to restart.
      // That's an acceptable trade for not running a polling loop.
      logger.debug({ dir, source }, 'Skill dir missing, watcher skipped');
      continue;
    }
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { recursive: true }, () => {
        scheduleRescan(projectSkillsDir, globalSkillsDir);
      });
    } catch (err: any) {
      // ENOTSUP on some filesystems → retry without recursive.
      try {
        watcher = fs.watch(dir, () => {
          scheduleRescan(projectSkillsDir, globalSkillsDir);
        });
      } catch (err2: any) {
        logger.warn(
          { dir, source, err: err2?.message || String(err2) },
          'Could not install skill watcher',
        );
        continue;
      }
      logger.debug({ dir }, 'Skill watcher fell back to non-recursive');
    }
    watcher.on('error', (err) => {
      logger.warn({ dir, err: err?.message || String(err) }, 'Skill watcher error');
    });
    activeWatchers.push(watcher);
  }
}

function scheduleRescan(projectSkillsDir: string, globalSkillsDir: string): void {
  if (rescanTimer) clearTimeout(rescanTimer);
  // 500ms debounce: editors often emit several change events in quick
  // succession (atomic write = unlink + rename), and a fresh skill being
  // copied in trips dozens of inotify events as files settle.
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    try {
      rescanAll(projectSkillsDir, globalSkillsDir);
      logger.info({ count: skills.size }, 'Skill registry rescanned after change');
    } catch (err: any) {
      logger.warn({ err: err?.message || String(err) }, 'Skill registry rescan failed');
    }
  }, 500);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Scan skills/ (relative to project root) and ~/.claude/skills/ to
 * populate the registry. Safe to call multiple times; clears previous state.
 *
 * `projectRootOverride` redirects the project-skills scan to a different
 * directory — used by tests to point at a temp fixture root instead of the
 * real repo. In production the override is omitted and the path is derived
 * from this file's location via fileURLToPath() (decodes URL-encoded chars
 * so paths with spaces / parens / unicode resolve correctly).
 */
export function initSkillRegistry(projectRootOverride?: string): void {
  // Tear down any prior watchers (e.g. test re-init) before installing new
  // ones so we don't leak handles or fire stale callbacks.
  teardownWatchers();
  skills = new Map();

  // fileURLToPath decodes URL-encoded characters (e.g. %20 → space).
  // The previous implementation used `new URL(import.meta.url).pathname`
  // directly, which left %20 in the path and silently broke the project
  // skills scan for anyone whose clone path contained a space.
  let projectRoot = projectRootOverride
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  if (!fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))) {
    logger.debug({ projectRoot }, 'CLAUDE.md not found at expected project root');
  }

  const projectSkillsDir = path.join(projectRoot, 'skills');
  const globalSkillsDir = path.join(os.homedir(), '.claude', 'skills');

  rescanAll(projectSkillsDir, globalSkillsDir);
  logger.info({ count: skills.size }, 'Skill registry initialized');

  // Wire live reload. The watcher is best-effort — if it fails the registry
  // still serves the initial scan, and the user can restart to refresh.
  try {
    installWatchers(projectSkillsDir, globalSkillsDir);
  } catch (err: any) {
    logger.warn({ err: err?.message || String(err) }, 'Skill watcher install failed');
  }
}

/**
 * Tear down filesystem watchers. Exposed for tests so vitest can stop
 * pending timers between cases. Production code never calls this — the
 * watchers live for the process lifetime.
 */
export function _stopSkillRegistryForTest(): void {
  teardownWatchers();
}

/**
 * Return a compact index of all skills, one line per skill.
 * Format: "skill_id: description"
 */
export function getSkillIndex(): string {
  return Array.from(skills.values())
    .map((s) => `${s.id}: ${s.description}`)
    .join('\n');
}

/**
 * Find skills whose trigger words appear in the message.
 */
export function matchSkills(message: string): SkillMeta[] {
  const lower = message.toLowerCase();
  const matched: SkillMeta[] = [];

  for (const skill of skills.values()) {
    for (const trigger of skill.triggerWords) {
      if (lower.includes(trigger)) {
        matched.push(skill);
        break;
      }
    }
  }

  return matched;
}

/**
 * Load the full SKILL.md content for a given skill ID.
 */
export function getSkillInstructions(id: string): string | null {
  const skill = skills.get(id);
  if (!skill) return null;

  try {
    return fs.readFileSync(skill.fullPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Return all registered skills.
 */
export function getAllSkills(): SkillMeta[] {
  return Array.from(skills.values());
}
