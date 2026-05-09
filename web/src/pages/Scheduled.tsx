import { useEffect, useMemo, useState } from 'preact/hooks';
import { Pause, Play, Trash2, Clock, LayoutGrid, List, CheckSquare, Plus, BellOff, MessageSquareOff, Info, ArrowRight } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { Pill, StatusDot } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { PrivacyToggle } from '@/components/PrivacyToggle';
import { ConfirmModal } from '@/components/ConfirmModal';
import { EditTaskModal } from '@/components/EditTaskModal';
import { Modal } from '@/components/Modal';
import { ScheduleBuilder } from '@/components/ScheduleBuilder';
import { ChatWithAgentButton } from '@/components/ChatWithAgentButton';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiDelete } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { privacyBlur } from '@/lib/privacy';
import { pushToast } from '@/lib/toasts';
import { describeCron, classifyTaskHealth, type HealthStat } from '@/lib/cron';

interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent_id: string;
  started_at: number | null;
  last_status: 'success' | 'failed' | 'timeout' | null;
  silent_start: number;
  silent_result: number;
}

type ViewMode = 'cards' | 'list';

function formatCountdown(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff < 0) return 'overdue';
  if (diff < 60) return 'in ' + Math.floor(diff) + 's';
  if (diff < 3600) return 'in ' + Math.floor(diff / 60) + 'm';
  if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + 'h';
  return 'in ' + Math.floor(diff / 86400) + 'd';
}

const VIEW_KEY = 'claudeclaw.scheduled.view';

function loadView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'cards' || v === 'list') return v;
  } catch {}
  return 'cards';
}

export function Scheduled() {
  const { data, loading, error, refresh } = useFetch<{ tasks: ScheduledTask[] }>('/api/tasks', 30_000);
  const tasks = data?.tasks ?? [];
  const [view, setView] = useState<ViewMode>(loadView());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState<null | 'single' | 'bulk'>(null);
  const [pendingSingle, setPendingSingle] = useState<ScheduledTask | null>(null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const blurOn = privacyBlur('scheduled').value;

  function setViewPersisted(v: ViewMode) {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function selectAll() {
    if (selected.size === tasks.length) setSelected(new Set());
    else setSelected(new Set(tasks.map((t) => t.id)));
  }

  async function performBulkDelete() {
    setBusy(true);
    const ids = Array.from(selected);
    let ok = 0, failed = 0;
    for (const id of ids) {
      try {
        await apiDelete(`/api/tasks/${id}`);
        ok++;
      } catch { failed++; }
    }
    setSelected(new Set());
    refresh();
    setBusy(false);
    if (failed === 0) {
      pushToast({ tone: 'warn', title: `Deleted ${ok} task${ok === 1 ? '' : 's'}` });
    } else {
      pushToast({
        tone: 'error',
        title: `Deleted ${ok}, failed ${failed}`,
        description: 'Check the audit log for details.',
        durationMs: 7000,
      });
    }
  }

  async function performSingleDelete() {
    if (!pendingSingle) return;
    setBusy(true);
    try {
      await apiDelete(`/api/tasks/${pendingSingle.id}`);
      pushToast({ tone: 'warn', title: 'Task deleted' });
      refresh();
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err), durationMs: 6000 });
    } finally {
      setBusy(false);
      setPendingSingle(null);
    }
  }

  async function action(task: ScheduledTask, act: 'pause' | 'resume') {
    try {
      if (act === 'pause') await apiPost(`/api/tasks/${task.id}/pause`);
      else await apiPost(`/api/tasks/${task.id}/resume`);
      refresh();
      pushToast({ tone: 'success', title: act === 'pause' ? 'Task paused' : 'Task resumed' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: `${act} failed`, description: err?.message || String(err), durationMs: 6000 });
    }
  }

  const allSelected = tasks.length > 0 && selected.size === tasks.length;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Scheduled"
        actions={
          <>
            <span class="text-[11.5px] text-[var(--color-text-muted)] tabular-nums">
              {tasks.length} scheduled{selected.size > 0 ? ` · ${selected.size} selected` : ''}
            </span>
            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => setConfirmOpen('bulk')}
                disabled={busy}
                class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-white bg-[var(--color-status-failed)] hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <Trash2 size={12} /> Delete {selected.size}
              </button>
            )}
            <PrivacyToggle section="scheduled" />
            <ViewSwitcher view={view} onChange={setViewPersisted} />
            <button
              type="button"
              onClick={() => setCreating(true)}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
              data-testid="new-scheduled-task-button"
            >
              <Plus size={14} /> New Scheduled Task
            </button>
          </>
        }
      />

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}
      {!loading && !error && tasks.length === 0 && (
        <PageState
          empty
          emptyTitle="No scheduled tasks"
          emptyDescription="Use mission-cli or ask the bot to create a recurring task. They'll show up here when they're scheduled."
        />
      )}

      {tasks.length > 0 && view === 'cards' && (
        <div class="flex-1 overflow-y-auto p-6" data-testid="view-cards">
          <div class="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
            {tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                blurOn={blurOn}
                selected={selected.has(t.id)}
                onToggleSelect={() => toggleSelect(t.id)}
                onAction={(a) => action(t, a)}
                onDeleteRequest={() => { setPendingSingle(t); setConfirmOpen('single'); }}
                onEdit={() => setEditing(t)}
              />
            ))}
          </div>
        </div>
      )}

      {tasks.length > 0 && view === 'list' && (
        <div class="flex-1 overflow-y-auto" data-testid="view-list">
          <table class="w-full text-[12.5px]">
            <thead class="sticky top-0 bg-[var(--color-bg)] border-b border-[var(--color-border)] z-10">
              <tr class="text-left">
                <th class="px-6 py-2 w-[36px]">
                  <button
                    type="button"
                    onClick={selectAll}
                    class="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                    title={allSelected ? 'Clear selection' : 'Select all'}
                  >
                    <CheckSquare size={14} class={allSelected ? 'text-[var(--color-accent)]' : ''} />
                  </button>
                </th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Prompt</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[18%]">Schedule</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[10%]">Next</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[10%]">Status</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[8%]">Agent</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[12%] text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <TaskListRow
                  key={t.id}
                  task={t}
                  blurOn={blurOn}
                  selected={selected.has(t.id)}
                  onToggleSelect={() => toggleSelect(t.id)}
                  onAction={(a) => action(t, a)}
                  onDeleteRequest={() => { setPendingSingle(t); setConfirmOpen('single'); }}
                  onEdit={() => setEditing(t)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EditTaskModal
        open={editing !== null}
        task={editing}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />

      <CreateScheduledTaskModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={refresh}
      />

      <ConfirmModal
        open={confirmOpen === 'single'}
        onClose={() => { setConfirmOpen(null); setPendingSingle(null); }}
        onConfirm={performSingleDelete}
        title="Delete this scheduled task?"
        body={pendingSingle ? truncateForBlur(pendingSingle.prompt, 140, blurOn) : ''}
        detail="The task and its schedule are removed. Past run results stay in the history table."
        confirmLabel="Delete"
        destructive
      />
      <ConfirmModal
        open={confirmOpen === 'bulk'}
        onClose={() => setConfirmOpen(null)}
        onConfirm={performBulkDelete}
        title={`Delete ${selected.size} scheduled task${selected.size === 1 ? '' : 's'}?`}
        body="All selected tasks will be removed and won't fire again. Past run results stay in the history table."
        confirmLabel={`Delete ${selected.size}`}
        destructive
      />
    </div>
  );
}

function truncateForBlur(text: string, max: number, blur: boolean): string {
  if (blur) return '(prompt hidden — turn off blur to see full text)';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function ViewSwitcher({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div class="inline-flex bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-0.5">
      <button
        type="button"
        onClick={() => onChange('cards')}
        class={[
          'inline-flex items-center justify-center w-7 h-7 rounded transition-colors',
          view === 'cards' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
        ].join(' ')}
        title="Card view"
        data-testid="view-toggle-cards"
        aria-pressed={view === 'cards'}
      >
        <LayoutGrid size={13} />
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        class={[
          'inline-flex items-center justify-center w-7 h-7 rounded transition-colors',
          view === 'list' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
        ].join(' ')}
        title="List view"
        data-testid="view-toggle-list"
        aria-pressed={view === 'list'}
      >
        <List size={13} />
      </button>
    </div>
  );
}

interface RowProps {
  task: ScheduledTask;
  blurOn: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onAction: (a: 'pause' | 'resume') => void;
  onDeleteRequest: () => void;
  onEdit: () => void;
}

function TaskCard({ task, blurOn, selected, onToggleSelect, onAction, onDeleteRequest, onEdit }: RowProps) {
  const [showResult, setShowResult] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const statusTone = task.status === 'running' ? 'running' : task.status === 'paused' ? 'cancelled' : 'done';
  const blurClass = blurOn && !revealed ? 'privacy-blur' : (blurOn && revealed ? 'privacy-blur revealed' : '');

  return (
    <div
      class={[
        'bg-[var(--color-card)] border rounded-lg p-3 hover:border-[var(--color-border-strong)] transition-colors cursor-pointer group',
        selected ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]',
      ].join(' ')}
      onClick={onEdit}
    >
      <div class="flex items-start gap-2 mb-2">
        <input
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          class="mt-1 shrink-0 cursor-pointer accent-[var(--color-accent)]"
        />
        <div class="flex-1 min-w-0">
          <div
            class={'text-[12.5px] text-[var(--color-text)] line-clamp-2 leading-snug mb-1 ' + blurClass}
            onClick={(e) => { if (blurOn) { e.stopPropagation(); setRevealed((v) => !v); } }}
          >
            {task.prompt}
          </div>
          <div class="flex items-center gap-2 text-[10.5px] text-[var(--color-text-faint)] flex-wrap">
            <span class="inline-flex items-center gap-1">
              <Clock size={10} />
              {describeCron(task.schedule).text}
            </span>
            {task.status === 'active' && (
              <span class="text-[var(--color-accent)] tabular-nums">{formatCountdown(task.next_run)}</span>
            )}
            <Pill tone={statusTone}>{task.status}</Pill>
            {task.silent_start ? (
              <span class="inline-flex items-center gap-1 text-[var(--color-text-faint)]" title="Silent start: no pre-announce">
                <BellOff size={11} />
                <span class="text-[10.5px]">silent start</span>
              </span>
            ) : null}
            {task.silent_result ? (
              <span class="inline-flex items-center gap-1 text-[var(--color-text-faint)]" title="Silent result: no result message on Telegram">
                <MessageSquareOff size={11} />
                <span class="text-[10.5px]">silent result</span>
              </span>
            ) : null}
            {task.agent_id !== 'main' && <span class="font-mono">@{task.agent_id}</span>}
            {task.agent_id && (
              <span onClick={(e) => e.stopPropagation()}>
                <ChatWithAgentButton agentId={task.agent_id} size={14} />
              </span>
            )}
          </div>
          <div class="mt-1.5" data-testid="health-summary">
            <HealthSummary task={task} />
          </div>
        </div>
        <RowActions task={task} onAction={onAction} onDeleteRequest={onDeleteRequest} />
      </div>
      {task.last_result && (
        <div class="mt-2 pt-2 border-t border-[var(--color-border)]" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setShowResult((v) => !v)}
            class="text-[10.5px] text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]"
          >
            {showResult ? 'Hide' : 'Show'} last result · {formatRelativeTime(task.last_run || 0)}
          </button>
          {showResult && (
            <div
              class={'mt-1.5 text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed line-clamp-6 ' + blurClass}
              onClick={(e) => { if (blurOn) { e.stopPropagation(); setRevealed((v) => !v); } }}
            >
              {task.last_result}
            </div>
          )}
        </div>
      )}
      <div onClick={(e) => e.stopPropagation()}>
        <RecentRunsPanel task={task} />
      </div>
    </div>
  );
}

function TaskListRow({ task, blurOn, selected, onToggleSelect, onAction, onDeleteRequest, onEdit }: RowProps) {
  const [revealed, setRevealed] = useState(false);
  const statusTone = task.status === 'running' ? 'running' : task.status === 'paused' ? 'cancelled' : 'done';
  const blurClass = blurOn && !revealed ? 'privacy-blur' : (blurOn && revealed ? 'privacy-blur revealed' : '');

  return (
    <tr
      class={'cursor-pointer ' + (selected ? 'bg-[var(--color-accent-soft)] border-b border-[var(--color-border)]' : 'border-b border-[var(--color-border)] hover:bg-[var(--color-elevated)] transition-colors')}
      onClick={onEdit}
    >
      <td class="px-6 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          class="cursor-pointer accent-[var(--color-accent)]"
        />
      </td>
      <td class="px-3 py-2.5 max-w-0">
        <span
          class={'text-[var(--color-text)] line-clamp-2 ' + blurClass}
          onClick={(e) => { if (blurOn) { e.stopPropagation(); setRevealed((v) => !v); } }}
        >
          {task.prompt}
        </span>
      </td>
      <td class="px-3 py-2.5 text-[var(--color-text-muted)] tabular-nums whitespace-nowrap">
        {describeCron(task.schedule).text}
      </td>
      <td class="px-3 py-2.5 text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">
        {task.status === 'active' ? formatCountdown(task.next_run) : '—'}
      </td>
      <td class="px-3 py-2.5 whitespace-nowrap" data-testid="list-status-cell">
        <div class="flex items-center gap-1.5">
          <Pill tone={statusTone}>{task.status}</Pill>
          <span data-testid="health-summary"><HealthSummary task={task} /></span>
          {task.silent_start ? (
            <span class="inline-flex items-center text-[var(--color-text-faint)]" title="Silent start: no pre-announce">
              <BellOff size={11} />
            </span>
          ) : null}
          {task.silent_result ? (
            <span class="inline-flex items-center text-[var(--color-text-faint)]" title="Silent result: no result message on Telegram">
              <MessageSquareOff size={11} />
            </span>
          ) : null}
        </div>
      </td>
      <td class="px-3 py-2.5 font-mono text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
        <span class="inline-flex items-center gap-1">
          @{task.agent_id}
          <span onClick={(e) => e.stopPropagation()}>
            <ChatWithAgentButton agentId={task.agent_id} size={14} />
          </span>
        </span>
      </td>
      <td class="px-3 py-2.5 text-right whitespace-nowrap">
        <RowActions task={task} onAction={onAction} onDeleteRequest={onDeleteRequest} />
      </td>
    </tr>
  );
}

// ── Health row ────────────────────────────────────────────────────
//
// Single-line summary that combines schedule preview, last-run
// freshness, and the status dot. The dot tone comes from
// classifyTaskHealth (see web/src/lib/cron.ts) which returns one of
// done | medium | failed | neutral. We translate that into the
// Pill/StatusDot palette so the row matches the rest of the app.
function healthDotTone(h: HealthStat): 'done' | 'medium' | 'failed' | 'neutral' {
  return h.tone;
}

function HealthSummary({ task }: { task: ScheduledTask }) {
  const health = useMemo(
    () => classifyTaskHealth({
      cron: task.schedule,
      lastRun: task.last_run,
      lastStatus: task.last_status,
      status: task.status,
    }),
    [task.schedule, task.last_run, task.last_status, task.status],
  );
  const lastRunLabel = task.last_run
    ? `last run ${formatRelativeTime(task.last_run)}`
    : 'no runs yet';
  return (
    <span class="inline-flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-faint)]" title={`${health.label} · interval ~${health.intervalSec ? Math.round(health.intervalSec / 60) + 'm' : 'n/a'}`}>
      <StatusDot tone={healthDotTone(health)} />
      <span class="tabular-nums">{lastRunLabel}</span>
      <span>·</span>
      <span class={
        health.tone === 'failed' ? 'text-[var(--color-status-failed)]'
        : health.tone === 'medium' ? 'text-[var(--color-priority-medium)]'
        : health.tone === 'done' ? 'text-[var(--color-status-done)]'
        : 'text-[var(--color-text-faint)]'
      }>{health.label}</span>
    </span>
  );
}

// ── Recent runs panel ─────────────────────────────────────────────
//
// Honest disclosure: src/scheduler.ts runs scheduled tasks INLINE via
// runAgent() and only persists `last_run`/`last_result`/`last_status`
// on the scheduled_tasks row. There is no scheduled_runs history
// table today, and /api/activity?source=scheduled returns 0 rows
// because the scheduler doesn't insert mission_tasks on each fire.
//
// This panel surfaces the architectural gap clearly instead of
// fabricating a history. The "See all in Activity" link is
// future-proofed with the URL params Wave 1A's Activity feed will
// recognise once the scheduler is wired.
function RecentRunsPanel({ task }: { task: ScheduledTask }) {
  const activityHref = `/mission?activity_source=scheduled&activity_source_id=${encodeURIComponent(task.id)}`;
  return (
    <div class="mt-2 pt-2 border-t border-[var(--color-border)]" data-testid="recent-runs-panel">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">Recent runs</div>
      {task.last_run ? (
        <div class="text-[11px] text-[var(--color-text-muted)] tabular-nums" data-testid="recent-runs-last">
          Last run: {formatRelativeTime(task.last_run)}
          {task.last_status ? ` · ${task.last_status}` : ''}
        </div>
      ) : (
        <div class="text-[11px] text-[var(--color-text-faint)]" data-testid="recent-runs-last">
          No runs captured yet.
        </div>
      )}
      <div class="mt-2 flex items-start gap-1.5 text-[10.5px] text-[var(--color-text-faint)] leading-relaxed" data-testid="deferred-history-note">
        <Info size={11} class="shrink-0 mt-0.5" />
        <span>
          Older runs aren't yet captured. Scheduled fires will populate the unified Activity
          feed once <code class="font-mono text-[10px]">src/scheduler.ts</code> writes a
          mission_tasks row per fire (deferred slice).
        </span>
      </div>
      <a
        href={activityHref}
        onClick={(e) => e.stopPropagation()}
        class="mt-1.5 inline-flex items-center gap-1 text-[10.5px] text-[var(--color-accent)] hover:underline"
        data-testid="see-all-in-activity"
      >
        See all in Activity
        <ArrowRight size={11} />
      </a>
    </div>
  );
}

function RowActions({ task, onAction, onDeleteRequest }: {
  task: ScheduledTask;
  onAction: (a: 'pause' | 'resume') => void;
  onDeleteRequest: () => void;
}) {
  return (
    <div class="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {task.status === 'active' && (
        <button
          type="button"
          onClick={() => onAction('pause')}
          class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          title="Pause"
        >
          <Pause size={12} />
        </button>
      )}
      {task.status === 'paused' && (
        <button
          type="button"
          onClick={() => onAction('resume')}
          class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-elevated)] transition-colors"
          title="Resume"
        >
          <Play size={12} />
        </button>
      )}
      <button
        type="button"
        onClick={onDeleteRequest}
        class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-elevated)] transition-colors"
        title="Delete"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// ── Create modal ───────────────────────────────────────────────────────
//
// Mirrors the visual layout of EditTaskModal but creates a new task via
// POST /api/tasks. Validates cron client-side using the same describeCron
// helper that the scheduler's cron-parser library powers, so a clearly
// invalid cron disables the Save button before the server round-trip.
//
// Server still validates (cron-parser) — this is a UX shortcut only.

interface AgentLite { id: string; name: string }

const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 8am', cron: '0 8 * * 1-5' },
  { label: 'Every Monday 9am', cron: '0 9 * * 1' },
  { label: 'Every Sunday 6pm', cron: '0 18 * * 0' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
];

function CreateScheduledTaskModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [agentId, setAgentId] = useState('main');
  const [skill, setSkill] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const agents = useFetch<{ agents: AgentLite[] }>(open ? '/api/agents' : null);
  const cronPreview = useMemo(() => describeCron(cron), [cron]);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setPrompt(''); setCron('0 9 * * *'); setAgentId('main');
      setSkill(''); setTitle(''); setErr(null);
    }
  }, [open]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        agent_id: agentId,
        prompt: prompt.trim(),
        cron: cron.trim(),
      };
      if (skill.trim()) body.skill = skill.trim();
      if (title.trim()) body.title = title.trim();
      await apiPost('/api/tasks', body);
      pushToast({ tone: 'success', title: 'Task scheduled' });
      onCreated();
      onClose();
    } catch (e: any) {
      const msg = e?.body?.error || e?.message || String(e);
      setErr(msg);
      pushToast({ tone: 'error', title: 'Create failed', description: msg, durationMs: 7000 });
    } finally {
      setBusy(false);
    }
  }

  const canSave = !busy && cronPreview.ok && prompt.trim().length > 0 && agentId.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New scheduled task"
      width={620}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            class="px-3 py-1.5 rounded text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            data-testid="create-scheduled-task-save"
            class="ml-auto px-3 py-1.5 rounded text-[12.5px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : 'Create'}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-4">
        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Title <span class="text-[var(--color-text-faint)]">(optional)</span>
          </label>
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="Defaults to first 60 chars of prompt"
            maxLength={200}
            data-testid="create-scheduled-task-title"
            class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]"
          />
        </div>

        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Prompt
          </label>
          <textarea
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            rows={6}
            autoFocus
            placeholder="Full instructions for the agent. Max 10000 chars."
            maxLength={10000}
            data-testid="create-scheduled-task-prompt"
            class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] font-mono leading-relaxed resize-y"
          />
        </div>

        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Schedule
          </label>
          <ScheduleBuilder
            cron={cron}
            onChange={setCron}
            externalError={cronPreview.ok ? null : cronPreview.text}
          />
          <div class="mt-3 flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCron(p.cron)}
                class={[
                  'text-[10.5px] px-2 py-1 rounded transition-colors',
                  cron === p.cron
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] border border-[var(--color-accent)]'
                    : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:text-[var(--color-text)]',
                ].join(' ')}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
              Agent
            </label>
            <select
              value={agentId}
              onInput={(e) => setAgentId((e.target as HTMLSelectElement).value)}
              data-testid="create-scheduled-task-agent"
              class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]"
            >
              <option value="main">@main</option>
              {agents.data?.agents
                ?.filter((a) => a.id !== 'main')
                .map((a) => (
                  <option key={a.id} value={a.id}>@{a.id} {a.name && a.name !== a.id ? `· ${a.name}` : ''}</option>
                ))}
            </select>
          </div>
          <div>
            <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
              Skill <span class="text-[var(--color-text-faint)]">(optional)</span>
            </label>
            <input
              type="text"
              value={skill}
              onInput={(e) => setSkill((e.target as HTMLInputElement).value)}
              placeholder="e.g. gmail"
              class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] font-mono"
            />
          </div>
        </div>

        {err && (
          <div class="text-[11.5px] text-[var(--color-status-failed)] bg-[var(--color-status-failed-soft,_rgba(255,0,0,0.08))] border border-[var(--color-status-failed)] rounded px-2 py-1.5">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}
