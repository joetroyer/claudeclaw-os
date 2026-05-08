// Background poller that closes stale "live" meet sessions when the
// upstream provider (Pika or Daily) reports them ended.
//
// Without this, ending a Google Meet on the user's side leaves the row
// stuck on `live` indefinitely — until the operator manually clicks
// Leave or restarts the bot. The poller fills that gap by checking
// each provider's session-status endpoint every POLL_INTERVAL_MS.

import { listActiveMeetSessions, markMeetSessionLeft, markMeetSessionFailed } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getRoom as dailyGetRoom, DailyApiError } from './daily-client.js';

const POLL_INTERVAL_MS = 30_000;
const PIKA_API_BASE = 'https://srkibaanghvsriahb.pika.art/proxy/realtime';
// Treat sessions stuck in `joining` for too long as failed. Pika's join
// flow finishes within ~90s; if we still see joining at 5min the
// subprocess crashed before it could mark the row.
const STALE_JOINING_MS = 5 * 60 * 1000;

function pikaDevKey(): string | null {
  if (process.env.PIKA_DEV_KEY) return process.env.PIKA_DEV_KEY;
  const fromEnv = readEnvFile(['PIKA_DEV_KEY', 'PIKA_API_KEY']);
  return fromEnv.PIKA_DEV_KEY || fromEnv.PIKA_API_KEY || null;
}

function extractDailyRoom(meetUrl: string): string | null {
  try {
    return new URL(meetUrl).pathname.replace(/^\/+/, '').split('/')[0] || null;
  } catch {
    return null;
  }
}

async function checkPikaSession(sid: string, devKey: string): Promise<'live' | 'ended' | 'failed' | 'unknown'> {
  try {
    const r = await fetch(`${PIKA_API_BASE}/session/${encodeURIComponent(sid)}`, {
      headers: { Authorization: `DevKey ${devKey}` },
    });
    if (r.status === 404) return 'ended'; // Pika cleaned it up; row is stale.
    if (!r.ok) return 'unknown';
    const j = (await r.json().catch(() => null)) as { status?: string; error_message?: string } | null;
    if (!j) return 'unknown';
    if (j.status === 'closed' || j.status === 'ended') return 'ended';
    if (j.status === 'error') return 'failed';
    return 'live';
  } catch {
    return 'unknown';
  }
}

async function checkDailyRoom(meetUrl: string): Promise<'live' | 'ended' | 'unknown'> {
  const room = extractDailyRoom(meetUrl);
  if (!room) return 'unknown';
  try {
    await dailyGetRoom(room);
    return 'live';
  } catch (err) {
    if (err instanceof DailyApiError && err.status === 404) return 'ended';
    return 'unknown';
  }
}

async function pollOnce(): Promise<void> {
  const active = listActiveMeetSessions();
  if (active.length === 0) return;
  const devKey = pikaDevKey();
  const now = Date.now();

  for (const s of active) {
    // Stale-joining cleanup: rows that never transitioned out of joining.
    if (s.status === 'joining' && now - s.created_at * 1000 > STALE_JOINING_MS) {
      try {
        markMeetSessionFailed(s.id, 'stale joining: poller timeout');
        logger.info({ sessionId: s.id, provider: s.provider }, 'meet-poller: marked stale-joining session as failed');
      } catch { /* best-effort */ }
      continue;
    }

    if (s.status !== 'live') continue;

    if (s.provider === 'pika') {
      if (!devKey) continue;
      const verdict = await checkPikaSession(s.id, devKey);
      if (verdict === 'ended') {
        try {
          markMeetSessionLeft(s.id, null);
          logger.info({ sessionId: s.id }, 'meet-poller: Pika session ended, marked left');
        } catch { /* best-effort */ }
      } else if (verdict === 'failed') {
        try {
          markMeetSessionFailed(s.id, 'Pika reported session error');
          logger.info({ sessionId: s.id }, 'meet-poller: Pika session error, marked failed');
        } catch { /* best-effort */ }
      }
    } else if (s.provider === 'daily') {
      const verdict = await checkDailyRoom(s.meet_url);
      if (verdict === 'ended') {
        try {
          markMeetSessionLeft(s.id, null);
          logger.info({ sessionId: s.id }, 'meet-poller: Daily room gone, marked left');
        } catch { /* best-effort */ }
      }
    }
  }
}

let _timer: NodeJS.Timeout | null = null;

export function startMeetSessionPoller(): void {
  if (_timer) return; // idempotent
  _timer = setInterval(() => {
    pollOnce().catch((err) => logger.warn({ err }, 'meet-poller: pass failed'));
  }, POLL_INTERVAL_MS);
  // Run once at startup to clean up stuck rows from a previous bot crash.
  setTimeout(() => {
    pollOnce().catch((err) => logger.warn({ err }, 'meet-poller: initial pass failed'));
  }, 5_000);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'meet-poller: started');
}

export function stopMeetSessionPoller(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
