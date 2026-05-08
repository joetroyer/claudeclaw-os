import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';
import path from 'path';

import { PROJECT_ROOT } from './config.js';

const WA_DAEMON_BASE = 'http://localhost:4242';

// Reuse the same SQLite file the wa-daemon writes/reads. Opened lazily so
// agent processes that don't ever call WhatsApp tools don't churn an FD.
let _db: Database.Database | null = null;
function db(): Database.Database {
  if (!_db) _db = new Database(path.join(PROJECT_ROOT, 'store', 'claudeclaw.db'));
  return _db;
}

interface WaChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  unread: number;
  lastTs: number;
  lastBody: string;
}

// Pull the full chat list from wa-daemon's HTTP API. Has every thread
// WhatsApp Web knows about — including contacts who messaged before
// the daemon started capturing.
async function fetchAllChats(): Promise<WaChatSummary[]> {
  try {
    const r = await fetch(`${WA_DAEMON_BASE}/chats`);
    if (!r.ok) return [];
    const j = (await r.json()) as { chats?: WaChatSummary[] };
    return j.chats ?? [];
  } catch {
    return [];
  }
}

// Resolve a contact name to its canonical WhatsApp chat_id. Strategy:
//   1. If input already looks like a chat_id, accept literally.
//   2. Otherwise try wa-daemon /chats (full list, sees historical contacts).
//   3. Fall back to wa_messages (people who've messaged us since daemon up).
// Picks the most recently active match when several names overlap.
async function resolveContact(input: string): Promise<{ chat_id: string; name: string } | null> {
  const trimmed = input.trim();
  if (/@(c|g|lid)\.?(us)?$/.test(trimmed) || /@/.test(trimmed)) {
    return { chat_id: trimmed, name: trimmed };
  }
  const needle = trimmed.toLowerCase();

  const chats = await fetchAllChats();
  if (chats.length > 0) {
    const matches = chats
      .filter((c) => c.name && c.name.toLowerCase().includes(needle))
      .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
    if (matches.length > 0) return { chat_id: matches[0].id, name: matches[0].name };
  }

  const row = db()
    .prepare(
      `SELECT chat_id, contact_name AS name
       FROM wa_messages
       WHERE LOWER(contact_name) LIKE ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(`%${needle}%`) as { chat_id: string; name: string } | undefined;
  return row ?? null;
}

export const waToolsServer = createSdkMcpServer({
  name: 'whatsapp',
  version: '0.1.0',
  tools: [
    tool(
      'whatsapp_send',
      `Send a WhatsApp message to anyone in the user's full WhatsApp chat history. THIS IS THE ONLY WAY TO SEND WHATSAPP MESSAGES — always use this tool when the user asks to "WhatsApp X", "message X on WhatsApp", "text X via WhatsApp", or anything similar.

The 'to' field accepts either a contact name (e.g. 'Sven', 'Ryan Claudio', 'Mom') or a raw chat_id. The tool resolves names against the live WhatsApp Web chat list (274+ threads typically). Do NOT refuse to call this tool based on uncertainty about whether a contact exists — if a lookup fails, the tool will tell you and you can call whatsapp_list_chats to investigate. The chat list updates constantly. IMPORTANT: You must have explicit user confirmation before calling this tool. Draft the message, show it to the user, and wait for approval before sending.

CRITICAL — message body rules:
- Send EXACTLY what the user told you to send. No salutations the user didn't write. No "Hey <name>," prefix unless the user typed it. No sign-off unless the user typed it.
- Do not paraphrase, expand, or "polish" the user's words. Pass them through verbatim.
- The only acceptable transformation is to extract just the message portion from a request like 'WhatsApp Sven that I'm running late' → body should be "I'm running late", not "Hey Sven, I'm running late". When the user dictates a message via voice, treat the literal transcription as the body.
- If the user's message was sent via voice and contains stutters, filler words, or auto-correct artifacts (e.g. "ROTAP" for "Rotap"), use your judgment to fix obvious transcription errors but never add content the user didn't say.`,
      {
        to: z.string().describe("Contact name (case-insensitive substring match) or chat_id like '1234567890@c.us'."),
        body: z.string().describe('EXACT message body the user dictated. Do not add greetings, names, or signoffs the user did not type. WhatsApp supports *bold*, _italic_, ~strike~.'),
      },
      async ({ to, body }) => {
        const target = await resolveContact(to);
        if (!target) {
          // Pull a hint of similar names so Claude can pick a likely match
          // and retry instead of refusing.
          const all = await fetchAllChats();
          const fragment = to.toLowerCase().split(/\s+/)[0]?.slice(0, 3) ?? '';
          const hints = all
            .filter((c) => c.name && fragment && c.name.toLowerCase().includes(fragment))
            .slice(0, 5)
            .map((c) => `${c.name} [${c.id}]`)
            .join(', ');
          return {
            content: [
              {
                type: 'text',
                text: `No exact WhatsApp contact matching "${to}".${hints ? ` Closest matches: ${hints}. Retry whatsapp_send with one of those names if it's the right person.` : ' Use whatsapp_list_chats to see all 274+ threads, then retry whatsapp_send with the right name.'} If you have a phone number, format it as <digits-only>@c.us.`,
              },
            ],
            isError: true,
          };
        }
        try {
          db()
            .prepare(`INSERT INTO wa_outbox (to_chat_id, body, created_at) VALUES (?, ?, ?)`)
            .run(target.chat_id, body, Math.floor(Date.now() / 1000));
          return {
            content: [
              {
                type: 'text',
                text: `Queued WhatsApp to ${target.name} (${target.chat_id}). Will deliver within 3 seconds.`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Queue failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
    tool(
      'whatsapp_list_chats',
      'List WhatsApp chat threads (most-recent first), including historical contacts that predate the wa-daemon. Pulls from the live WhatsApp Web client via the wa-daemon HTTP API. Use this BEFORE giving up on a contact lookup.',
      { limit: z.number().int().min(1).max(50).default(25).describe('Max threads to return.') },
      async ({ limit }) => {
        const chats = await fetchAllChats();
        if (chats.length > 0) {
          const lines = chats
            .slice(0, limit)
            .map((c) => `• ${c.name || c.id} [${c.id}]${c.isGroup ? ' (group)' : ''} — "${(c.lastBody ?? '').slice(0, 60)}"`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        // Fallback: only-incoming view from wa_messages.
        const rows = db()
          .prepare(
            `SELECT contact_name, chat_id, MAX(timestamp) AS last_ts,
                    (SELECT body FROM wa_messages m2
                     WHERE m2.chat_id = m1.chat_id ORDER BY id DESC LIMIT 1) AS last_body
             FROM wa_messages m1
             GROUP BY chat_id
             ORDER BY last_ts DESC
             LIMIT ?`,
          )
          .all(limit) as Array<{ contact_name: string; chat_id: string; last_ts: number; last_body: string }>;
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: 'No WhatsApp threads visible. The wa-daemon may not be running.' }] };
        }
        const lines = rows.map((r) => `• ${r.contact_name} [${r.chat_id}] — "${(r.last_body ?? '').slice(0, 60)}"`);
        return { content: [{ type: 'text', text: lines.join('\n') + '\n\n(only incoming-since-daemon-up; full chat list unavailable)' }] };
      },
    ),
    tool(
      'whatsapp_recent_messages',
      'Read the most recent WhatsApp messages for a given contact (or all contacts if omitted). Useful for replying in context.',
      {
        contact: z.string().optional().describe('Contact name or chat_id. If omitted, returns most recent across all contacts.'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      async ({ contact, limit }) => {
        let rows: Array<{ contact_name: string; body: string; ts: number; from_me: number }>;
        if (contact) {
          const target = await resolveContact(contact);
          if (!target) {
            return { content: [{ type: 'text', text: `No contact matching "${contact}".` }], isError: true };
          }
          rows = db()
            .prepare(
              `SELECT contact_name, body, timestamp AS ts, is_from_me AS from_me
               FROM wa_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
            )
            .all(target.chat_id, limit) as typeof rows;
        } else {
          rows = db()
            .prepare(
              `SELECT contact_name, body, timestamp AS ts, is_from_me AS from_me
               FROM wa_messages ORDER BY id DESC LIMIT ?`,
            )
            .all(limit) as typeof rows;
        }
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: 'No messages found.' }] };
        }
        const lines = rows.reverse().map((r) => {
          const who = r.from_me ? 'You' : r.contact_name;
          const time = new Date(r.ts * 1000).toISOString().replace('T', ' ').slice(0, 16);
          return `[${time}] ${who}: ${r.body}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      },
    ),
  ],
});
