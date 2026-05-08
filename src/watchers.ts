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
import { lookupN8nWorkflowOwner } from './db.js';
import { readEnvFile } from './env.js';

// Resolved at call time so tests can override via CLAUDECLAW_STORE_DB_PATH
// (Slice 4 contract tests). Production: always falls back to the canonical
// store path under PROJECT_ROOT. No production code path reads the env var.
function storeDbPath(): string {
  return process.env.CLAUDECLAW_STORE_DB_PATH || path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');
}
// Back-compat: keep the named const as a snapshot of the production value
// so log lines / static reads still work for any caller that imported it.
const STORE_DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');
void STORE_DB_PATH;

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
  | { 'run-skill': { agent: string; skill: string; title?: string; prompt?: string } }
  // ── Slice 4: n8n auto-task routing ─────────────────────────────────
  // Side-effect action: read `payload.<workflow_field>` and consult the
  // n8n_workflow_owners table. Sets internal vars `_owner_agent` (string
  // or empty), `_owner_found` (true|false), and `_n8n_debounced`
  // (true|false). Subsequent `if-owned` / `if-unowned` actions consult
  // these gates. Also computes a debounce key from
  // workflow_id + error_signature and short-circuits if the same pair
  // was processed within `debounce_sec` (default 60).
  | { 'lookup-owner': { workflow_field?: string; signature_field?: string; debounce_sec?: number } }
  // Conditional wrappers — the nested action list runs only if the prior
  // `lookup-owner` matched the corresponding gate AND the pair was not
  // debounced. Order matters: a YAML actions list must contain
  // `lookup-owner` BEFORE any `if-owned` / `if-unowned`, or the gates
  // default closed (skip).
  | { 'if-owned': Action[] }
  | { 'if-unowned': Action[] }
  // Post a templated message to a Slack incoming-webhook URL. The webhook
  // URL is read from env (`webhook_url_env` field, default
  // `SLACK_WEBHOOK_URL`). Channel is optional and only honored if the
  // webhook URL accepts a `channel` override; the template field
  // supports {payload.x} substitutions like other actions.
  | { 'send-slack': { template: string; channel?: string; webhook_url_env?: string } };

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
  const db = new Database(storeDbPath());
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
  const db = new Database(storeDbPath());
  try {
    db.prepare(
      `UPDATE meet_sessions SET status='left', left_at=? WHERE id=? AND status='live'`,
    ).run(Math.floor(Date.now() / 1000), id);
    logger.info({ id }, 'watcher: marked stale meet session as left');
  } finally {
    db.close();
  }
}

// ── Slice 4: n8n routing helpers ─────────────────────────────────────

/**
 * In-memory debounce map for n8n error routing. Keyed by
 * `<workflow_id>::<error_signature>`. Value is the unix-ms timestamp of
 * the last fire. Same key fired within `debounce_sec` is treated as a
 * duplicate and short-circuits the action chain.
 *
 * Process-local — a bot restart clears the map. That's acceptable for a
 * 60s debounce window: even if the same error fires through a restart
 * we'd at most double-queue one mission on rare crash-recovery, which
 * the meta agent is built to triage. Persisting this would require a
 * new table and a write per fire — way more cost than benefit.
 */
const N8N_DEBOUNCE = new Map<string, number>();
const N8N_DEBOUNCE_MAX_ENTRIES = 1000; // bounded — purge oldest if exceeded

function pruneDebounce(now: number): void {
  if (N8N_DEBOUNCE.size <= N8N_DEBOUNCE_MAX_ENTRIES) return;
  // Drop entries older than 5 minutes (well past any 60s debounce window).
  for (const [k, t] of N8N_DEBOUNCE) {
    if (now - t > 5 * 60 * 1000) N8N_DEBOUNCE.delete(k);
  }
  // Still over? drop oldest by insertion order (Map preserves it).
  if (N8N_DEBOUNCE.size > N8N_DEBOUNCE_MAX_ENTRIES) {
    const overflow = N8N_DEBOUNCE.size - N8N_DEBOUNCE_MAX_ENTRIES;
    let i = 0;
    for (const k of N8N_DEBOUNCE.keys()) {
      if (i++ >= overflow) break;
      N8N_DEBOUNCE.delete(k);
    }
  }
}

/** @internal — exposed for tests. Resets the debounce cache. */
export function _resetN8nDebounceForTests(): void {
  N8N_DEBOUNCE.clear();
}

/**
 * Compute a stable signature for an error string. If the payload already
 * contains an explicit signature/fingerprint field, use that verbatim;
 * otherwise hash the error message (first 500 chars) so cosmetic noise
 * like timestamps doesn't break debounce.
 */
function computeErrorSignature(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  const trimmed = raw.slice(0, 500);
  // Lightweight FNV-1a — no need for crypto strength; we only want
  // deterministic equivalence for identical error text.
  let h = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface N8nLookupResult {
  ownerAgent: string | null;
  ownerFound: boolean;
  debounced: boolean;
  workflowId: string;
  errorSignature: string;
}

function performN8nLookup(
  vars: Record<string, unknown>,
  cfg: { workflow_field?: string; signature_field?: string; debounce_sec?: number },
): N8nLookupResult {
  const workflowField = cfg.workflow_field || 'workflow_id';
  const signatureField = cfg.signature_field || 'error_signature';
  const debounceMs = (cfg.debounce_sec ?? 60) * 1000;

  // Read fields out of the payload object (preferred) or top-level vars
  // (fallback) so a flat payload like `{workflow_id: ...}` also works.
  const payload = (vars.payload && typeof vars.payload === 'object')
    ? vars.payload as Record<string, unknown>
    : {};

  const readField = (name: string): string => {
    const fromPayload = payload[name];
    if (typeof fromPayload === 'string' || typeof fromPayload === 'number') return String(fromPayload);
    const fromVars = vars[name];
    if (typeof fromVars === 'string' || typeof fromVars === 'number') return String(fromVars);
    return '';
  };

  const workflowId = readField(workflowField);
  // Try the explicit signature field first (e.g. n8n's `errorSignature`,
  // `fingerprint`, or `error_id`). Fall back to hashing the error message.
  let errorSignature = readField(signatureField);
  if (!errorSignature) {
    const errMsg = readField('error_message') || readField('error') || '';
    errorSignature = computeErrorSignature(errMsg) || readField('execution_id') || '';
  }

  // Use the shared db helper so this respects the same singleton
  // connection as the rest of the runtime (and the in-memory test DB
  // used by `_initTestDatabase`). Returns null on missing/empty input.
  let ownerAgent: string | null = null;
  if (workflowId) {
    try {
      ownerAgent = lookupN8nWorkflowOwner(workflowId);
    } catch (err) {
      logger.warn({ err, workflowId }, 'watcher: n8n owner lookup failed');
    }
  }

  // Debounce decision: same workflow_id + error_signature within window.
  // If either field is empty, we still debounce on the (workflow_id, '')
  // pair so a flood of identical-no-signature errors collapses; but a
  // missing workflow_id disables debounce (every unknown firing must
  // reach meta).
  let debounced = false;
  if (workflowId) {
    const key = `${workflowId}::${errorSignature}`;
    const now = Date.now();
    const last = N8N_DEBOUNCE.get(key);
    if (last !== undefined && now - last < debounceMs) {
      debounced = true;
    } else {
      N8N_DEBOUNCE.set(key, now);
      pruneDebounce(now);
    }
  }

  return { ownerAgent, ownerFound: !!ownerAgent, debounced, workflowId, errorSignature };
}

/**
 * Post a Slack message via incoming-webhook URL read from env. Best-effort:
 * a 4xx/5xx or thrown error is logged but does not abort the action chain.
 * Avoids a hard dependency on Slack — if the env var is missing we log
 * and skip so dev environments don't generate spurious failures.
 *
 * Two URL shapes supported:
 *   - native Slack incoming webhook (hooks.slack.com/services/...): body
 *     `{ text, channel? }` per Slack's spec.
 *   - n8n "Jarvis Slack Messenger" workflow (path contains
 *     /jarvis-slack): body `{ target, message }` per the workflow's
 *     trigger schema. The workflow handles the actual Slack API call
 *     using its OAuth credential. Channel falls back to integration-alerts.
 */
async function sendSlack(template: string, channel: string | undefined, webhookUrlEnv: string): Promise<boolean> {
  const url = process.env[webhookUrlEnv];
  if (!url) {
    logger.warn({ webhookUrlEnv }, 'watcher: send-slack skipped (env var unset)');
    return false;
  }
  try {
    const isJarvisN8n = url.includes('/jarvis-slack');
    const body: Record<string, unknown> = isJarvisN8n
      ? { target: channel || 'integration-alerts', message: template }
      : (channel ? { text: template, channel } : { text: template });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: txt.slice(0, 200) }, 'watcher: send-slack non-2xx');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'watcher: send-slack failed');
    return false;
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
        // Slice 4: agent is now also templated (e.g. `{_owner_agent}`) so
        // routing decisions made by `lookup-owner` can flow into the
        // queue. Pre-Slice-4 callers pass static agent strings; substitute()
        // is a no-op on a string with no `{name}` patterns, so this is
        // backwards compatible with all existing watcher entries.
        const agent = substitute(m.agent, vars);
        const id = queueMission(agent, substitute(m.title, vars), substitute(m.prompt, vars));
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
      } else if ('lookup-owner' in a) {
        // Slice 4: side-effect — populate vars._owner_agent / _owner_found /
        // _n8n_debounced so subsequent if-owned / if-unowned can branch.
        const cfg = a['lookup-owner'] || {};
        const r = performN8nLookup(vars, cfg);
        vars._owner_agent = r.ownerAgent ?? '';
        vars._owner_found = r.ownerFound;
        vars._n8n_debounced = r.debounced;
        vars._workflow_id = r.workflowId;
        vars._error_signature = r.errorSignature;
        flat._owner_agent = r.ownerAgent ?? '';
        flat.workflow_id = r.workflowId;
        flat.error_signature = r.errorSignature;
        if (r.debounced) {
          logger.info(
            { workflow_id: r.workflowId, error_signature: r.errorSignature },
            'watcher: n8n debounce hit — skipping nested actions',
          );
        }
      } else if ('if-owned' in a) {
        // Gate: only run nested actions if the prior lookup-owner found
        // an owner AND the event was not debounced. Defaults closed if
        // no lookup-owner ran first.
        if (vars._owner_found === true && vars._n8n_debounced !== true) {
          const nested = a['if-owned'];
          const nestedIds = await runActions(nested, vars);
          queuedIds.push(...nestedIds);
        }
      } else if ('if-unowned' in a) {
        if (vars._owner_found === false && vars._n8n_debounced !== true) {
          const nested = a['if-unowned'];
          const nestedIds = await runActions(nested, vars);
          queuedIds.push(...nestedIds);
        }
      } else if ('send-slack' in a) {
        // Slice 4: post to a Slack incoming-webhook URL. The webhook URL
        // is configurable via env var (defaults to SLACK_WEBHOOK_URL) so
        // multiple Slack endpoints (e.g. #ops vs #alerts) can be wired
        // by referencing different env names per action.
        const m = a['send-slack'];
        const text = substitute(m.template, vars);
        const channel = m.channel ? substitute(m.channel, vars) : undefined;
        const envName = m.webhook_url_env || 'SLACK_WEBHOOK_URL';
        await sendSlack(text, channel, envName);
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
    const db = new Database(storeDbPath());
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

// Load .env keys referenced by watchers (secret_env, webhook_url_env) into
// process.env. The project's readEnvFile is allowlist-based and does NOT
// auto-populate process.env (security: keep secrets out of child processes
// by default). But webhook handlers + send-slack actions reference env vars
// dynamically by name, so we explicitly load only what watchers.yaml asks
// for. Idempotent + cached: safe to call from multiple entry points
// (module-import, startWatchers, request-time).
let _watcherEnvLoaded = false;
function ensureWatcherEnvLoaded(): void {
  if (_watcherEnvLoaded) return;
  _watcherEnvLoaded = true;
  try {
    const cfgPath = path.join(PROJECT_ROOT, 'watchers.yaml');
    if (!fs.existsSync(cfgPath)) return;
    const parsed = yaml.load(fs.readFileSync(cfgPath, 'utf-8')) as WatchersFile;
    const wantedEnv = new Set<string>();
    // Walk an action list, recursing into if-owned/if-unowned which wrap
    // nested action lists. Each conditional's value is itself an Action[].
    const walk = (actions: unknown[]): void => {
      for (const a of actions ?? []) {
        if (!a || typeof a !== 'object') continue;
        const obj = a as Record<string, unknown>;
        if ('send-slack' in obj) {
          const ss = obj['send-slack'] as { webhook_url_env?: string };
          if (ss?.webhook_url_env) wantedEnv.add(ss.webhook_url_env);
        }
        if ('if-owned' in obj && Array.isArray(obj['if-owned'])) walk(obj['if-owned'] as unknown[]);
        if ('if-unowned' in obj && Array.isArray(obj['if-unowned'])) walk(obj['if-unowned'] as unknown[]);
      }
    };
    for (const w of parsed.watchers ?? []) {
      if (w.type === 'webhook' && w.secret_env) wantedEnv.add(w.secret_env);
      if (w.type === 'log-tail') for (const t of w.triggers ?? []) walk(t.actions as unknown[]);
      else if (w.type === 'sqlite-poll' || w.type === 'webhook') walk(w.actions as unknown[]);
    }
    if (wantedEnv.size > 0) {
      const loaded = readEnvFile([...wantedEnv]);
      for (const [k, v] of Object.entries(loaded)) {
        if (!process.env[k]) process.env[k] = v;
      }
      logger.info(
        { keys: [...wantedEnv], loaded: Object.keys(loaded).length },
        'watcher: loaded watcher-referenced env vars from .env',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'watcher: failed to load watcher env vars; HMAC checks may fail');
  }
}

// Run at module import so env vars are available before the dashboard
// gets its first webhook request, regardless of whether startWatchers()
// is invoked from the bot's boot path.
ensureWatcherEnvLoaded();

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

  // Watcher env loading happens at module-import time via
  // ensureWatcherEnvLoaded() so it runs even when startWatchers() isn't
  // explicitly invoked.
  ensureWatcherEnvLoaded();

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
