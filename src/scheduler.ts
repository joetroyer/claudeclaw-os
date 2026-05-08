import { randomBytes } from 'crypto';
import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist } from './config.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  getMissionTask,
  createMissionTask,
  markMissionTaskRunning,
} from './db.js';
import type { ScheduledTask } from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let sender: Sender;

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, () => executeScheduledTask(task, nextRun));
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

/**
 * Slice 9 scheduler bridge: wraps the inline cron run with a mission_tasks
 * row carrying `source='scheduled'` + `source_id=<scheduled_task.id>` so
 * the Activity feed (`/api/activity?source=scheduled`) actually returns
 * rows for cron fires. Without this, scheduled fires were invisible to
 * the feed because the scheduler runs `runAgent` inline and never queues
 * a mission_task.
 *
 * Exported (with the `_` prefix) so the integration test can drive a
 * single fire end-to-end without booting the 60s setInterval loop.
 */
export async function executeScheduledTask(
  task: ScheduledTask,
  nextRun: number,
  runner: typeof runAgent = runAgent,
  send: Sender = sender,
): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

  // Provenance row: created queued, immediately flipped to running so the
  // same agent's next 60s mission-poll tick can't re-claim it. We use
  // markMissionTaskRunning directly (not claimNextMissionTask) because
  // this row is executed inline here, not by the mission worker.
  const missionId = `sch_${randomBytes(4).toString('hex')}`;
  const missionTitle = (task.prompt.slice(0, 60) || `scheduled:${task.id}`);
  try {
    createMissionTask(
      missionId,
      missionTitle,
      task.prompt,
      task.agent_id,
      'scheduler',
      5,
      Boolean(task.silent_start),
      Boolean(task.silent_result),
      'scheduled',
      task.id,
    );
    markMissionTaskRunning(missionId);
  } catch (provErr) {
    // Provenance write failure must not break the scheduled task itself.
    // Log and proceed — the activity feed loses one row, the user's task
    // still runs.
    logger.warn({ err: provErr, taskId: task.id, missionId }, 'scheduler: failed to write mission_tasks provenance row');
  }

  try {
    if (!task.silent_start) {
      await send(`Scheduled task running: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`);
    }

    // Run as a fresh agent call (no session — scheduled tasks are autonomous)
    const result = await runner(task.prompt, undefined, () => {}, undefined, undefined, abortController, undefined, agentMcpAllowlist);
    clearTimeout(timeout);

    if (result.aborted) {
      updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
      try { completeMissionTask(missionId, null, 'failed', 'Timed out after 10 minutes'); } catch (e) { logger.warn({ err: e, missionId }, 'scheduler: failed to mark mission_tasks failed (timeout)'); }
      await send(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
      logger.warn({ taskId: task.id, missionId }, 'Task timed out');
      return;
    }

    const text = result.text?.trim() || 'Task completed with no output.';
    if (!task.silent_result) {
      for (const chunk of splitMessage(formatForTelegram(text))) {
        await send(chunk);
      }

      // Inject task output into the active chat session so user replies have context.
      // Skipped when silent_result is set — if the user never saw the message on Telegram,
      // pre-loading it into chat context would surprise them on their next message.
      if (ALLOWED_CHAT_ID) {
        const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
        logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
        logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
      }
    }

    updateTaskAfterRun(task.id, nextRun, text, 'success');
    try { completeMissionTask(missionId, text, 'completed'); } catch (e) { logger.warn({ err: e, missionId }, 'scheduler: failed to mark mission_tasks completed'); }

    logger.info({ taskId: task.id, missionId, nextRun }, 'Task complete, next run scheduled');
  } catch (err) {
    clearTimeout(timeout);
    const errMsg = err instanceof Error ? err.message : String(err);
    updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');
    try { completeMissionTask(missionId, null, 'failed', errMsg.slice(0, 500)); } catch (e) { logger.warn({ err: e, missionId }, 'scheduler: failed to mark mission_tasks failed'); }

    logger.error({ err, taskId: task.id, missionId }, 'Scheduled task failed');
    try {
      await send(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
    } catch {
      // ignore send failure
    }
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

    // Cross-process cancel signal: dashboard flips status to 'cancelled' in
    // SQLite, this poll picks it up within 5s and aborts the runAgent call.
    let cancelledByUser = false;
    const cancelPoll = setInterval(() => {
      const current = getMissionTask(mission.id);
      if (current?.status === 'cancelled') {
        cancelledByUser = true;
        abortController.abort();
        clearInterval(cancelPoll);
      }
    }, 5_000);

    try {
      const result = await runAgent(mission.prompt, undefined, () => {}, undefined, undefined, abortController, undefined, agentMcpAllowlist);
      clearTimeout(timeout);
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
        } else {
          completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
          logger.warn({ missionId: mission.id }, 'Mission task timed out');
          try {
            await sender('Mission task timed out: "' + mission.title + '"');
          } catch (sendErr) {
            // Sender can fail for Telegram API blips or chat-not-found. We
            // still want to see it so the user isn't silently unnotified.
            logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
          }
        }
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id }, 'Mission task completed');

        if (!mission.silent_result) {
          // Send result to Telegram
          for (const chunk of splitMessage(formatForTelegram(text))) {
            await sender(chunk);
          }

          // Inject into conversation context so agent can reference it.
          // Skipped when silent_result is set so a future user message
          // doesn't get unexpected pre-context for a result they never saw.
          if (ALLOWED_CHAT_ID) {
            const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
            logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
            logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
          }
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
      } else {
        completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
        logger.error({ err, missionId: mission.id }, 'Mission task failed');
        try {
          await sender(`❌ Mission task failed: "${mission.title}" — ${errMsg.slice(0, 200)}`);
        } catch (sendErr) {
          logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission failure notification');
        }
      }
    } finally {
      clearInterval(cancelPoll);
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
