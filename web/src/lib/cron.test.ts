import { describe, it, expect } from 'vitest';
import { classifyTaskHealth } from './cron';

// Slice 9 Wave 1C — precedence contract for classifyTaskHealth.
//
// The contract (per the wave spec, reinforced by Codex review):
//   1. paused (when status='paused') wins over last_status, even if
//      the previous run failed.
//   2. awaiting first run (status active + last_run=null).
//   3. last run failed / timed out (based on last_status).
//   4. overdue (missed by 2x+ intervals).
//   5. late (missed by 1x interval).
//   6. healthy (last_run within expected interval AND last_status='success').
describe('classifyTaskHealth precedence', () => {
  // Daily 9am cron — interval should be ~24h.
  const cron = '0 9 * * *';
  const now = 1_700_000_000; // arbitrary unix seconds
  const oneHourAgo = now - 3600;
  const oneDayAgo = now - 86400;
  const threeDaysAgo = now - 3 * 86400;

  it('paused wins when last_status is failed', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: oneDayAgo,
      lastStatus: 'failed',
      status: 'paused',
      nowSec: now,
    });
    expect(h.label).toBe('paused');
    expect(h.tone).toBe('neutral');
  });

  it('paused wins when last_run is null', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: null,
      lastStatus: null,
      status: 'paused',
      nowSec: now,
    });
    expect(h.label).toBe('paused');
    expect(h.tone).toBe('neutral');
  });

  it('paused wins when last_status is timeout', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: oneDayAgo,
      lastStatus: 'timeout',
      status: 'paused',
      nowSec: now,
    });
    expect(h.label).toBe('paused');
  });

  it('active task with no last_run reports awaiting first run', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: null,
      lastStatus: null,
      status: 'active',
      nowSec: now,
    });
    expect(h.label).toBe('awaiting first run');
    expect(h.tone).toBe('neutral');
  });

  it('active task with last_status=failed reports last run failed', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: oneHourAgo,
      lastStatus: 'failed',
      status: 'active',
      nowSec: now,
    });
    expect(h.label).toBe('last run failed');
    expect(h.tone).toBe('failed');
  });

  it('active task with last_status=success within interval is healthy', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: oneHourAgo,
      lastStatus: 'success',
      status: 'active',
      nowSec: now,
    });
    expect(h.label).toBe('healthy');
    expect(h.tone).toBe('done');
  });

  it('active task with last_status=success but overdue (>2x) reports overdue', () => {
    const h = classifyTaskHealth({
      cron,
      lastRun: threeDaysAgo,
      lastStatus: 'success',
      status: 'active',
      nowSec: now,
    });
    expect(h.label).toBe('overdue');
    expect(h.tone).toBe('failed');
  });

  it('active task with last_status=success between 1x and 2x interval reports late', () => {
    // ~30h ago: more than 1 day, less than 2 days.
    const lateRun = now - (30 * 3600);
    const h = classifyTaskHealth({
      cron,
      lastRun: lateRun,
      lastStatus: 'success',
      status: 'active',
      nowSec: now,
    });
    expect(h.label).toBe('late');
    expect(h.tone).toBe('medium');
  });
});
