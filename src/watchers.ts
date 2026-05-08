// ── Watchers ──────────────────────────────────────────────────────────────────
//
// Lightweight event-driven watcher system. Loads a YAML config of watchers,
// runs them in-process inside the main bot, and routes triggers to handler
// functions. Two watcher types:
//
//   - log-tail:    tail a file via tail(1), match each new line against a
//                  regex, fire the watcher's actions on match (debounced).
//   - sqlite-poll: run a SELECT every interval_sec, fire actions for each
//                  new row (or rows matching a cursor).
//
// Handlers:
//   - send-telegram:  message ALLOWED_CHAT_ID with substituted vars
//   - queue-mission:  insert a mission_tasks row assigned to an agent
//   - mark-meet-stale: best-effort cleanup for stale Pika/Daily sessions
//
// Destructive actions (restart-process, etc.) are NOT autonomous — they
// always notify-only and require the user to invoke a confirmation
// command. This is a deliberate safety call.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';

import { PROJECT_ROOT, ALLOWED_CHAT_ID, activeBotToken } from './config.js';
import { logger } from './logger.js';
import Database from 'better-sqlite3';

const STORE_DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

// ── Types ─────────────────────────────────────────────────────────────────────

interface BaseTrigger {
  debounce_sec?: number;
  actions: Action[];
}
interface RegexTrigger extends BaseTrigger {
  regex: string;
}
export type Action =
  | { 'send-telegram': string }
  | { 'queue-mission': { agent: string; title: string; prompt: string } }
  | { 'mark-meet-stale': { id_field?: string } }
  // Slice 2: invoke a skill on an agent directly. Currently dispatches via
  // mission_tasks (skills run inside a mission turn) so we reuse the
  // existing mission worker rather than forking a parallel runtime.
  | { 'run-skill': { agent: string; skill: string; title?: string; prompt?: string } };

interface LogTailWatcherCfg {
  name: string;
  type: 'log-tail';
  path: string;
  triggers: RegexTrigger[];
}
interface SqlitePollWatcherCfg {
  name: string;
  type: 'sqlite-poll';
  sql: string;
  interval_sec: number;
  /** Optional cursor column (defaults to "id"); the highest seen value
   *  is persisted so re-starts don't re-fire historical rows. */
  cursor_column?: string;
  actions: Action[];
}
// Slice 2: webhook watcher.
//
// Externally addressable via POST /api/watchers/webhook/{slug}. The HTTP
// dispatcher lives in src/dashboard.ts; this watcher type is parsed and
// validated at startup but the runtime is HTTP-driven (no in-process
// timer). HMAC verification is mandatory on `run` mode; rejected on
// signature failure with 401.
//
//   mode: test    — fires actions, payload is logged with mode='test'
//   mode: preview — captures payload, NO actions fire
//   mode: run     — fires actions normally
//
// Defaults to `test` if missing (safer than `run`).
export interface WebhookWatcherCfg {
  name: string;
  type: 'webhook';
  /** Slug used in the public URL: /api/watchers/webhook/{slug} */
  slug: string;
  /** Env var name holding the HMAC shared secret. Required. */
  secret_env: string;
  /** Operating mode. Defaults to 'test'. */
  mode?: 'test' | 'preview' | 'run';
  actions: Action[];
}
export type WatcherCfg = LogTailWatcherCfg | SqlitePollWatcherCfg | WebhookWatcherCfg;

interface WatchersFile { watchers: WatcherCfg[] }

// ── Cursor persistence ────────────────────────────────────────────────────────

const CURSOR_FILE = path.join(PROJECT_ROOT, 'store', 'watcher-cursors.json');

function loadCursors(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8')); } catch { return {}; }
}
function saveCursors(c: Record<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
    fs.writeFileSync(CURSOR_FILE, JSON.stringify(c, null, 2));
  } catch (err) {
    logger.warn({ err }, 'watcher: failed to persist cursors');
  }
}

// ── Action runner ─────────────────────────────────────────────────────────────

/**
 * Substitute {name} placeholders in a template string. Supports nested
 * dotted keys like {payload.signal} and {payload.body.amount} when vars
 * contains structured objects under those parent keys (e.g. payload).
 *
 * Slice 2: Webhook payloads are arbitrary JSON, so callers can reference
 * any field with dot-paths. Missing keys leave the {literal} intact so a
 * miswired template surfaces visibly instead of producing empty strings.
 */
export function substitute(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (_, k: string) => {
    const parts = k.split('.');
    let cur: unknown = vars;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return `{${k}}`;
      }
    }
    if (cur === null || cur === undefined) return `{${k}}`;
    if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
    try { return JSON.stringify(cur); } catch { return `{${k}}`; }
  });
}

async function sendTelegram(text: string): Promise<void> {
  const token = activeBotToken;
  if (!token || !ALLOWED_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALLOWED_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    logger.warn({ err }, 'watcher: telegram send failed');
  }
}

function queueMission(agent: string, title: string, prompt: string, createdBy = 'watcher'): string {
  const db = new Database(STORE_DB_PATH);
  try {
    const id = `wat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, priority, created_at, created_by)
       VALUES (?, ?, ?, ?, 'queued', 50, ?, ?)`,
    ).run(id, title, prompt, agent, Math.floor(Date.now() / 1000), createdBy);
    logger.info({ id, agent, title, createdBy }, 'watcher: queued mission task');
    return id;
  } finally {
    db.close();
  }
}

function markMeetStale(id: string): void {
  const db = new Database(STORE_DB_PATH);
  try {
    db.prepare(
      `UPDATE meet_sessions SET status='left', left_at=? WHERE id=? AND status='live'`,
    ).run(Math.floor(Date.now() / 1000), id);
    logger.info({ id }, 'watcher: marked stale meet session as left');
  } finally {
    db.close();
  }
}

/**
 * Run a list of actions with the given variable substitutions. Returns
 * the list of mission_task IDs produced (used by the webhook dispatcher
 * to surface "what just got queued" back to the caller).
 */
export async function runActions(actions: Action[], vars: Record<string, unknown>): Promise<string[]> {
  const queuedIds: string[] = [];
  // Flatten primitive vars one level so legacy templates like {match}/{line}
  // and the new {payload.field} both work without rewriting existing entries.
  const flat: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) flat[k] = undefined;
    else if (typeof v === 'string' || typeof v === 'number') flat[k] = v;
    else if (typeof v === 'boolean') flat[k] = String(v);
  }
  for (const a of actions) {
    try {
      if ('send-telegram' in a) {
        await sendTelegram(substitute(a['send-telegram'], vars));
      } else if ('queue-mission' in a) {
        const m = a['queue-mission'];
        const id = queueMission(m.agent, substitute(m.title, vars), substitute(m.prompt, vars));
        queuedIds.push(id);
      } else if ('mark-meet-stale' in a) {
        const idField = a['mark-meet-stale'].id_field || 'id';
        const id = flat[idField];
        if (id) markMeetStale(String(id));
      } else if ('run-skill' in a) {
        // Slice 2: run-skill currently dispatches via mission_tasks so we
        // reuse the existing queue+worker pattern. The agent's mission
        // worker reads the prompt and invokes the named skill.
        const m = a['run-skill'];
        const title = substitute(m.title || `Run skill: ${m.skill}`, vars);
        const basePrompt = m.prompt
          ? substitute(m.prompt, vars)
          : `Run the \`${m.skill}\` skill with this payload:\n\n${typeof vars.payload === 'string' ? vars.payload : JSON.stringify(vars.payload ?? vars, null, 2)}`;
        const prompt = `[Triggered via webhook · skill=${m.skill}]\n\n${basePrompt}`;
        const id = queueMission(m.agent, title, prompt, 'watcher:webhook');
        queuedIds.push(id);
      }
    } catch (err) {
      logger.warn({ err, action: Object.keys(a)[0] }, 'watcher: action failed');
    }
  }
  return queuedIds;
}

// ── Webhook watcher config loader ──────────────────────────────────────
//
// The HTTP route in src/dashboard.ts uses this to look up a watcher by
// slug. We re-read watchers.yaml on each call rather than caching: the
// file is small, ops sometimes edit it without a bot restart, and the
// security boundary is HMAC verification (not config caching).

export function loadWebhookWatcher(slug: string): WebhookWatcherCfg | null {
  try {
    const cfgPath = path.join(PROJECT_ROOT, 'watchers.yaml');
    if (!fs.existsSync(cfgPath)) return null;
    const parsed = yaml.load(fs.readFileSync(cfgPath, 'utf-8')) as WatchersFile;
    for (const w of parsed.watchers ?? []) {
      if (w.type === 'webhook' && w.slug === slug) return w;
    }
    return null;
  } catch (err) {
    logger.warn({ err, slug }, 'watcher: failed to load webhook config');
    return null;
  }
}

export function listWebhookWatchers(): WebhookWatcherCfg[] {
  try {
    const cfgPath = path.join(PROJECT_ROOT, 'watchers.yaml');
    if (!fs.existsSync(cfgPath)) return [];
    const parsed = yaml.load(fs.readFileSync(cfgPath, 'utf-8')) as WatchersFile;
    return (parsed.watchers ?? []).filter(
      (w): w is WebhookWatcherCfg => w.type === 'webhook',
    );
  } catch (err) {
    logger.warn({ err }, 'watcher: failed to list webhook watchers');
    return [];
  }
}

// ── Log-tail watcher ──────────────────────────────────────────────────────────

function startLogTail(cfg: LogTailWatcherCfg): void {
  if (!fs.existsSync(cfg.path)) {
    // Best-effort: create an empty file so `tail -F` doesn't bail.
    try { fs.writeFileSync(cfg.path, ''); } catch { /* ignore */ }
  }
  const proc = spawn('tail', ['-n', '0', '-F', cfg.path]);
  let buf = '';
  const lastFireAt: Record<string, number> = {}; // by trigger regex string

  proc.stdout.on('data', async (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      for (const trig of cfg.triggers) {
        const re = new RegExp(trig.regex, 'i');
        const m = line.match(re);
        if (!m) continue;
        const debounce = (trig.debounce_sec ?? 0) * 1000;
        const now = Date.now();
        if (debounce > 0 && lastFireAt[trig.regex] && now - lastFireAt[trig.regex] < debounce) continue;
        lastFireAt[trig.regex] = now;
        await runActions(trig.actions, { match: m[0], line, watcher: cfg.name });
      }
    }
  });

  proc.on('exit', (code) => {
    logger.warn({ watcher: cfg.name, code }, 'watcher: tail exited; restarting in 10s');
    setTimeout(() => startLogTail(cfg), 10_000);
  });

  logger.info({ watcher: cfg.name, path: cfg.path }, 'watcher: log-tail started');
}

// ── SQLite-poll watcher ───────────────────────────────────────────────────────

function startSqlitePoll(cfg: SqlitePollWatcherCfg, cursors: Record<string, number>): void {
  const cursorCol = cfg.cursor_column || 'id';
  const intervalMs = cfg.interval_sec * 1000;

  async function tick(): Promise<void> {
    const db = new Database(STORE_DB_PATH);
    try {
      const lastSeen = cursors[cfg.name] ?? 0;
      // Allow {cursor} in the SQL — substitute the current cursor value
      const sql = cfg.sql.replace(/\{cursor\}/g, String(lastSeen));
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
      let newest = lastSeen;
      for (const row of rows) {
        const cursorVal = row[cursorCol];
        if (typeof cursorVal === 'number' && cursorVal > newest) newest = cursorVal;
        const vars: Record<string, string | number | undefined> = { watcher: cfg.name };
        for (const [k, v] of Object.entries(row)) {
          vars[k] = v === null ? '' : (v as string | number);
        }
        await runActions(cfg.actions, vars);
      }
      if (newest > lastSeen) {
        cursors[cfg.name] = newest;
        saveCursors(cursors);
      }
    } catch (err) {
      logger.warn({ err, watcher: cfg.name }, 'watcher: sqlite-poll failed');
    } finally {
      db.close();
    }
  }

  setInterval(() => { void tick(); }, intervalMs);
  // Initial run after 5s so we don't compete with bot startup.
  setTimeout(() => { void tick(); }, 5_000);
  logger.info({ watcher: cfg.name, interval_sec: cfg.interval_sec }, 'watcher: sqlite-poll started');
}

// ── Public API ────────────────────────────────────────────────────────────────

let _started = false;

export function startWatchers(): void {
  if (_started) return;
  _started = true;

  const cfgPath = path.join(PROJECT_ROOT, 'watchers.yaml');
  if (!fs.existsSync(cfgPath)) {
    logger.info('watchers.yaml not present; watcher system disabled');
    return;
  }

  let parsed: WatchersFile;
  try {
    parsed = yaml.load(fs.readFileSync(cfgPath, 'utf-8')) as WatchersFile;
  } catch (err) {
    logger.error({ err }, 'failed to parse watchers.yaml; disabling watchers');
    return;
  }

  const cursors = loadCursors();
  let webhookCount = 0;
  for (const w of parsed.watchers ?? []) {
    if (w.type === 'log-tail') startLogTail(w);
    else if (w.type === 'sqlite-poll') startSqlitePoll(w, cursors);
    else if (w.type === 'webhook') {
      // Slice 2: webhook watchers are HTTP-driven via /api/watchers/webhook/{slug}
      // — no in-process loop needed. We just log the registration so an
      // operator can confirm the slug is loaded at boot.
      webhookCount += 1;
      logger.info(
        { watcher: w.name, slug: w.slug, mode: w.mode || 'test' },
        'watcher: webhook registered (HTTP-driven)',
      );
    } else {
      logger.warn({ type: (w as { type?: string }).type }, 'watcher: unknown type');
    }
  }

  logger.info(
    { count: parsed.watchers?.length ?? 0, webhooks: webhookCount },
    'watchers: started',
  );
}
