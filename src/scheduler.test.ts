import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  _initTestDatabase,
  createScheduledTask,
  getDueTasks,
  getAllScheduledTasks,
  getScheduledTask,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  getMissionTasks,
} from './db.js';
import type { ScheduledTask } from './db.js';
import { executeScheduledTask } from './scheduler.js';

describe('task state machine', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  // ── Basic CRUD ────────────────────────────────────────────────────

  describe('createScheduledTask', () => {
    it('creates a task with correct defaults', () => {
      const nextRun = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'do something', '0 9 * * *', nextRun, 'main');

      const tasks = getAllScheduledTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('t1');
      expect(tasks[0].prompt).toBe('do something');
      expect(tasks[0].schedule).toBe('0 9 * * *');
      expect(tasks[0].status).toBe('active');
      expect(tasks[0].agent_id).toBe('main');
      expect(tasks[0].started_at).toBeNull();
      expect(tasks[0].last_status).toBeNull();
    });

    it('assigns correct agent_id', () => {
      const nextRun = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'check email', '0 9 * * *', nextRun, 'comms');

      const tasks = getAllScheduledTasks('comms');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].agent_id).toBe('comms');
    });

    it('defaults agent_id to main', () => {
      const nextRun = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'do something', '0 9 * * *', nextRun);

      const tasks = getAllScheduledTasks('main');
      expect(tasks).toHaveLength(1);
    });
  });

  // ── getDueTasks filtering ─────────────────────────────────────────

  describe('getDueTasks', () => {
    it('returns tasks where next_run is in the past', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'past task', '0 9 * * *', past, 'main');

      const due = getDueTasks('main');
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe('t1');
    });

    it('does not return future tasks', () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'future task', '0 9 * * *', future, 'main');

      const due = getDueTasks('main');
      expect(due).toHaveLength(0);
    });

    it('only returns tasks for the specified agent', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'main task', '0 9 * * *', past, 'main');
      createScheduledTask('t2', 'comms task', '0 9 * * *', past, 'comms');

      expect(getDueTasks('main')).toHaveLength(1);
      expect(getDueTasks('main')[0].id).toBe('t1');
      expect(getDueTasks('comms')).toHaveLength(1);
      expect(getDueTasks('comms')[0].id).toBe('t2');
    });

    it('does not return paused tasks', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'paused task', '0 9 * * *', past, 'main');
      pauseScheduledTask('t1');

      expect(getDueTasks('main')).toHaveLength(0);
    });

    it('does not return running tasks (double-fire prevention)', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'running task', '0 9 * * *', past, 'main');
      markTaskRunning('t1');

      const due = getDueTasks('main');
      expect(due).toHaveLength(0);
    });
  });

  // ── markTaskRunning ───────────────────────────────────────────────

  describe('markTaskRunning', () => {
    it('sets status to running and records started_at', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');

      markTaskRunning('t1');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('running');
      expect(tasks[0].started_at).toBeGreaterThan(0);
    });

    it('makes task invisible to getDueTasks', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');

      // Before marking: task is due
      expect(getDueTasks('main')).toHaveLength(1);

      markTaskRunning('t1');

      // After marking: task is no longer due
      expect(getDueTasks('main')).toHaveLength(0);
    });
  });

  // ── updateTaskAfterRun ────────────────────────────────────────────

  describe('updateTaskAfterRun', () => {
    it('resets status to active after success', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const futureNextRun = Math.floor(Date.now() / 1000) + 86400;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');
      markTaskRunning('t1');

      updateTaskAfterRun('t1', futureNextRun, 'All good', 'success');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('active');
      expect(tasks[0].last_status).toBe('success');
      expect(tasks[0].last_result).toBe('All good');
      expect(tasks[0].started_at).toBeNull();
      expect(tasks[0].next_run).toBe(futureNextRun);
      expect(tasks[0].last_run).toBeGreaterThan(0);
    });

    it('records failed status', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const futureNextRun = Math.floor(Date.now() / 1000) + 86400;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');
      markTaskRunning('t1');

      updateTaskAfterRun('t1', futureNextRun, 'Error: something broke', 'failed');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('active');
      expect(tasks[0].last_status).toBe('failed');
      expect(tasks[0].last_result).toBe('Error: something broke');
    });

    it('records timeout status', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const futureNextRun = Math.floor(Date.now() / 1000) + 86400;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');
      markTaskRunning('t1');

      updateTaskAfterRun('t1', futureNextRun, 'Timed out after 10 minutes', 'timeout');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('active');
      expect(tasks[0].last_status).toBe('timeout');
    });

    it('truncates last_result to 4000 chars', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const futureNextRun = Math.floor(Date.now() / 1000) + 86400;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');

      const longResult = 'x'.repeat(5000);
      updateTaskAfterRun('t1', futureNextRun, longResult, 'success');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].last_result).toHaveLength(4000);
    });

    it('clears started_at after completion', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const futureNextRun = Math.floor(Date.now() / 1000) + 86400;
      createScheduledTask('t1', 'task', '0 9 * * *', past, 'main');
      markTaskRunning('t1');

      // Verify started_at was set
      let tasks = getAllScheduledTasks('main');
      expect(tasks[0].started_at).toBeGreaterThan(0);

      updateTaskAfterRun('t1', futureNextRun, 'done', 'success');

      tasks = getAllScheduledTasks('main');
      expect(tasks[0].started_at).toBeNull();
    });
  });

  // ── resetStuckTasks (crash recovery) ──────────────────────────────

  describe('resetStuckTasks', () => {
    it('resets running tasks back to active for the given agent', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'stuck task', '0 9 * * *', past, 'main');
      markTaskRunning('t1');

      const count = resetStuckTasks('main');
      expect(count).toBe(1);

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('active');
      expect(tasks[0].started_at).toBeNull();
    });

    it('does not affect tasks from other agents', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'main stuck', '0 9 * * *', past, 'main');
      createScheduledTask('t2', 'comms stuck', '0 9 * * *', past, 'comms');
      markTaskRunning('t1');
      markTaskRunning('t2');

      // Reset only main
      const count = resetStuckTasks('main');
      expect(count).toBe(1);

      // main should be active
      const mainTasks = getAllScheduledTasks('main');
      expect(mainTasks[0].status).toBe('active');

      // comms should still be running
      const commsTasks = getAllScheduledTasks('comms');
      expect(commsTasks[0].status).toBe('running');
    });

    it('returns 0 when no tasks are stuck', () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'normal task', '0 9 * * *', future, 'main');

      const count = resetStuckTasks('main');
      expect(count).toBe(0);
    });

    it('does not affect paused tasks', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'paused task', '0 9 * * *', past, 'main');
      pauseScheduledTask('t1');

      resetStuckTasks('main');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('paused');
    });
  });

  // ── Double-fire prevention (integration-style) ────────────────────

  describe('double-fire prevention', () => {
    it('simulates the full lifecycle: due → running → complete', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const futureNextRun = Math.floor(Date.now() / 1000) + 86400;
      createScheduledTask('t1', 'morning briefing', '0 9 * * *', past, 'main');

      // Tick 1: scheduler finds the task
      const dueTick1 = getDueTasks('main');
      expect(dueTick1).toHaveLength(1);

      // Scheduler marks it running before executing
      markTaskRunning('t1');

      // Tick 2: 60 seconds later, scheduler checks again
      const dueTick2 = getDueTasks('main');
      expect(dueTick2).toHaveLength(0); // NOT returned — double-fire prevented

      // Task completes
      updateTaskAfterRun('t1', futureNextRun, 'Briefing done', 'success');

      // Tick 3: task is active again but next_run is in the future
      const dueTick3 = getDueTasks('main');
      expect(dueTick3).toHaveLength(0); // Not due yet
    });

    it('multiple tasks: only non-running ones are returned', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'task 1', '0 9 * * *', past, 'main');
      createScheduledTask('t2', 'task 2', '0 9 * * *', past, 'main');

      // Mark t1 as running
      markTaskRunning('t1');

      // Only t2 should be due
      const due = getDueTasks('main');
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe('t2');
    });
  });

  // ── Agent isolation ───────────────────────────────────────────────

  describe('agent isolation', () => {
    it('tasks created by different agents are fully isolated', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'main task', '0 9 * * *', past, 'main');
      createScheduledTask('t2', 'comms task', '0 9 * * *', past, 'comms');
      createScheduledTask('t3', 'ops task', '0 9 * * *', past, 'ops');

      expect(getDueTasks('main').map(t => t.id)).toEqual(['t1']);
      expect(getDueTasks('comms').map(t => t.id)).toEqual(['t2']);
      expect(getDueTasks('ops').map(t => t.id)).toEqual(['t3']);
    });

    it('getAllScheduledTasks with no filter returns all agents', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'main task', '0 9 * * *', past, 'main');
      createScheduledTask('t2', 'comms task', '0 9 * * *', past, 'comms');

      const all = getAllScheduledTasks();
      expect(all).toHaveLength(2);
    });

    it('getAllScheduledTasks with filter returns only that agent', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      createScheduledTask('t1', 'main task', '0 9 * * *', past, 'main');
      createScheduledTask('t2', 'comms task', '0 9 * * *', past, 'comms');

      expect(getAllScheduledTasks('main')).toHaveLength(1);
      expect(getAllScheduledTasks('comms')).toHaveLength(1);
      expect(getAllScheduledTasks('ops')).toHaveLength(0);
    });
  });

  // ── Pause/resume with new states ──────────────────────────────────

  describe('pause and resume', () => {
    it('pause sets status to paused', () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'task', '0 9 * * *', future, 'main');
      pauseScheduledTask('t1');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('paused');
    });

    it('resume sets status back to active', () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'task', '0 9 * * *', future, 'main');
      pauseScheduledTask('t1');
      resumeScheduledTask('t1');

      const tasks = getAllScheduledTasks('main');
      expect(tasks[0].status).toBe('active');
    });
  });

  // ── Delete ────────────────────────────────────────────────────────

  describe('deleteScheduledTask', () => {
    it('removes the task entirely', () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      createScheduledTask('t1', 'task', '0 9 * * *', future, 'main');
      deleteScheduledTask('t1');

      expect(getAllScheduledTasks()).toHaveLength(0);
    });
  });
});

// ── Slice 9: scheduler → mission_tasks provenance bridge ────────────────────
//
// When the scheduler fires a cron task, it should also emit a mission_tasks
// row stamped with `source='scheduled'` + `source_id=<scheduled_task.id>`
// so the Activity feed picks it up. These tests drive `executeScheduledTask`
// directly (skipping the 60s setInterval loop) with a stubbed runAgent and
// a no-op sender, and assert the resulting mission_tasks row.
describe('scheduler → mission_tasks provenance bridge', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const noopSender = async (_text: string): Promise<void> => { /* swallow */ };

  it('writes a completed mission_tasks row with source=scheduled on success', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask('cron-1', 'check inbox', '0 9 * * *', past, 'main');
    const task = getScheduledTask('cron-1');
    expect(task).not.toBeNull();

    const fakeRunner = vi.fn().mockResolvedValue({
      text: 'Inbox: 2 unread.',
      aborted: false,
    });

    await executeScheduledTask(task as ScheduledTask, past + 86400, fakeRunner as never, noopSender);

    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(fakeRunner.mock.calls[0][0]).toBe('check inbox');

    const rows = getMissionTasks();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source).toBe('scheduled');
    expect(row.source_id).toBe('cron-1');
    expect(row.assigned_agent).toBe('main');
    expect(row.created_by).toBe('scheduler');
    expect(row.status).toBe('completed');
    expect(row.result).toBe('Inbox: 2 unread.');
    expect(row.title).toBe('check inbox');
    expect(row.prompt).toBe('check inbox');
    expect(row.silent_start).toBe(0);
    expect(row.silent_result).toBe(0);
    expect(row.completed_at).toBeGreaterThan(0);
  });

  it('writes a failed mission_tasks row when runAgent throws', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask('cron-2', 'flaky job', '*/15 * * * *', past, 'main');
    const task = getScheduledTask('cron-2');

    const fakeRunner = vi.fn().mockRejectedValue(new Error('upstream 500'));

    await executeScheduledTask(task as ScheduledTask, past + 900, fakeRunner as never, noopSender);

    const rows = getMissionTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('upstream 500');
    expect(rows[0].source).toBe('scheduled');
    expect(rows[0].source_id).toBe('cron-2');
  });

  it('writes a failed mission_tasks row when runAgent returns aborted', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask('cron-3', 'long task', '0 * * * *', past, 'main');
    const task = getScheduledTask('cron-3');

    const fakeRunner = vi.fn().mockResolvedValue({ aborted: true, text: '' });

    await executeScheduledTask(task as ScheduledTask, past + 3600, fakeRunner as never, noopSender);

    const rows = getMissionTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('Timed out');
    expect(rows[0].source).toBe('scheduled');
    expect(rows[0].source_id).toBe('cron-3');
  });

  it('propagates silent_start / silent_result onto the mission_tasks row', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask('cron-4', 'quiet check', '0 6 * * *', past, 'main', true, true);
    const task = getScheduledTask('cron-4');
    expect(task?.silent_start).toBe(1);
    expect(task?.silent_result).toBe(1);

    const fakeRunner = vi.fn().mockResolvedValue({ text: 'ok', aborted: false });
    await executeScheduledTask(task as ScheduledTask, past + 86400, fakeRunner as never, noopSender);

    const rows = getMissionTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].silent_start).toBe(1);
    expect(rows[0].silent_result).toBe(1);
  });

  it('uses the scheduled task agent_id (cross-agent isolation)', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask('cron-5', 'comms job', '0 8 * * *', past, 'comms');
    const task = getScheduledTask('cron-5');

    const fakeRunner = vi.fn().mockResolvedValue({ text: 'done', aborted: false });
    await executeScheduledTask(task as ScheduledTask, past + 86400, fakeRunner as never, noopSender);

    const rows = getMissionTasks('comms');
    expect(rows).toHaveLength(1);
    expect(rows[0].assigned_agent).toBe('comms');

    expect(getMissionTasks('main')).toHaveLength(0);
  });

  it('still updates scheduled_tasks state machine (last_status=success) alongside the bridge', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask('cron-6', 'belt and braces', '0 9 * * *', past, 'main');
    const task = getScheduledTask('cron-6');

    const fakeRunner = vi.fn().mockResolvedValue({ text: 'ok', aborted: false });
    await executeScheduledTask(task as ScheduledTask, past + 86400, fakeRunner as never, noopSender);

    const refreshed = getScheduledTask('cron-6');
    expect(refreshed?.last_status).toBe('success');
    expect(refreshed?.last_result).toBe('ok');
  });
});
