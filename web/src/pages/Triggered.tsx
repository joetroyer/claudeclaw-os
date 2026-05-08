import { useEffect, useState } from 'preact/hooks';
import { Webhook, Copy, Check, PlayCircle, ChevronRight, ChevronDown, Plus, Pencil, Trash2 } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { useFetch } from '@/lib/useFetch';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { pushToast } from '@/lib/toasts';

// Slice 2 — Triggered Tasks UI.
//
// Lists every webhook watcher from /api/watchers/webhook, with per-watcher:
//   - copyable webhook URL
//   - mode badge (test | preview | run)
//   - secret-set indicator
//   - actions summary
//   - last-N payloads viewer (for preview mode payload-shape verification)
//   - fire-test-payload form (sends user-supplied JSON to the same actions
//     pipeline that production webhooks hit)

interface WebhookWatcher {
  name: string;
  slug: string;
  mode: 'test' | 'preview' | 'run';
  secret_env: string;
  secret_set: boolean;
  webhook_url: string;
  actions: unknown[];
}

interface WebhookPayloadRow {
  id: number;
  watcher_slug: string;
  payload_json: string;
  headers_json: string;
  signature_valid: number;
  mode: string;
  received_at: number;
  remote_ip: string;
}

export function Triggered() {
  const list = useFetch<{ watchers: WebhookWatcher[] }>('/api/watchers/webhook', 30_000);
  const watchers = list.data?.watchers ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebhookWatcher | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function performDelete() {
    if (!deletingSlug) return;
    setDeleteBusy(true);
    try {
      await apiDelete(`/api/watchers/${deletingSlug}`);
      pushToast({ tone: 'warn', title: 'Webhook deleted' });
      list.refresh();
    } catch (err: any) {
      const msg = err?.body?.error || err?.message || String(err);
      pushToast({ tone: 'error', title: 'Delete failed', description: msg, durationMs: 7000 });
    } finally {
      setDeleteBusy(false);
      setDeletingSlug(null);
    }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Triggered Tasks"
        actions={
          <>
            <span class="text-[11px] text-[var(--color-text-muted)]">
              {watchers.length} webhook{watchers.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={() => setCreating(true)}
              data-testid="new-triggered-task-button"
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
            >
              <Plus size={14} /> New Triggered Task
            </button>
          </>
        }
      />

      {list.error && <PageState error={list.error} />}
      {list.loading && !list.data && <PageState loading />}

      {!list.loading && !list.error && watchers.length === 0 && (
        <PageState
          empty
          emptyTitle="No webhook watchers configured"
          emptyDescription="Click `New Triggered Task` above, or add a `webhook` entry to watchers.yaml directly."
        />
      )}

      <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {watchers.map((w) => (
          <WatcherCard
            key={w.slug}
            watcher={w}
            onChange={list.refresh}
            onEdit={() => setEditing(w)}
            onDelete={() => setDeletingSlug(w.slug)}
          />
        ))}
      </div>

      <WatcherFormModal
        open={creating}
        existing={null}
        onClose={() => setCreating(false)}
        onSaved={list.refresh}
      />
      <WatcherFormModal
        open={editing !== null}
        existing={editing}
        onClose={() => setEditing(null)}
        onSaved={list.refresh}
      />
      <ConfirmModal
        open={deletingSlug !== null}
        onClose={() => { if (!deleteBusy) setDeletingSlug(null); }}
        onConfirm={performDelete}
        title="Delete this triggered task?"
        body={`The webhook \`${deletingSlug ?? ''}\` will be removed from watchers.yaml. Future POSTs to this URL will return 404.`}
        confirmLabel={deleteBusy ? 'Deleting…' : 'Delete'}
        destructive
      />
    </div>
  );
}

// ── Per-watcher card ────────────────────────────────────────────────────

function WatcherCard({
  watcher, onChange, onEdit, onDelete,
}: {
  watcher: WebhookWatcher;
  onChange: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [payloads, setPayloads] = useState<WebhookPayloadRow[] | null>(null);
  const [loadingPayloads, setLoadingPayloads] = useState(false);
  const [testJson, setTestJson] = useState('{\n  "signal": "buy",\n  "instrument": "XAUUSD",\n  "entry": 2350\n}');
  const [firing, setFiring] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(watcher.webhook_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      pushToast({ tone: 'error', title: 'Copy failed' });
    }
  }

  async function refreshPayloads() {
    setLoadingPayloads(true);
    try {
      const res = await apiGet<{ payloads: WebhookPayloadRow[] }>(
        `/api/watchers/webhook/${watcher.slug}/payloads?limit=10`,
      );
      setPayloads(res.payloads || []);
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Load failed', description: err?.message || String(err) });
    } finally {
      setLoadingPayloads(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && payloads === null) void refreshPayloads();
  }

  async function fireTest() {
    setFiring(true);
    setLastResult(null);
    let body: unknown;
    try {
      body = testJson.trim() ? JSON.parse(testJson) : {};
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Invalid JSON', description: err?.message || String(err) });
      setFiring(false);
      return;
    }
    try {
      const res = await apiPost<{ payload_id: number; queued_mission_tasks: string[] }>(
        `/api/watchers/webhook/${watcher.slug}/test`,
        body,
      );
      const ids = res.queued_mission_tasks || [];
      setLastResult(
        `Queued ${ids.length} mission_task${ids.length === 1 ? '' : 's'}` +
          (ids.length > 0 ? ': ' + ids.join(', ') : '') +
          ` (payload #${res.payload_id})`,
      );
      void refreshPayloads();
      onChange();
    } catch (err: any) {
      setLastResult('Failed: ' + (err?.message || err));
    } finally {
      setFiring(false);
    }
  }

  const modeColor: 'done' | 'accent' | 'neutral' =
    watcher.mode === 'run' ? 'done' :
    watcher.mode === 'preview' ? 'accent' :
    'neutral';

  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg overflow-hidden">
      {/* Header row */}
      <div class="px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={toggleOpen}
          class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] -ml-1"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <Webhook size={15} class="text-[var(--color-text-muted)]" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[14px] font-medium text-[var(--color-text)]">{watcher.name}</span>
            <Pill tone={modeColor}>{watcher.mode}</Pill>
            {!watcher.secret_set && <Pill tone="failed">secret missing</Pill>}
          </div>
          <div class="text-[11px] text-[var(--color-text-faint)] mt-0.5 font-mono truncate">
            slug: {watcher.slug} · secret_env: {watcher.secret_env}
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            data-testid={`edit-watcher-${watcher.slug}`}
            class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
            title="Edit"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            data-testid={`delete-watcher-${watcher.slug}`}
            class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-elevated)] transition-colors"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* URL row (always visible) */}
      <div class="px-4 pb-3 flex items-center gap-2">
        <code class="flex-1 text-[11.5px] bg-[var(--color-elevated)] px-2 py-1.5 rounded text-[var(--color-text)] truncate font-mono">
          {watcher.webhook_url}
        </code>
        <button
          type="button"
          onClick={copyUrl}
          class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] border border-[var(--color-border)] transition-colors"
          data-testid={`copy-url-${watcher.slug}`}
        >
          {copied ? <Check size={13} class="text-[var(--color-status-completed)]" /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy URL'}
        </button>
      </div>

      {/* Expanded body */}
      {open && (
        <div class="border-t border-[var(--color-border)] px-4 py-4 space-y-4">
          {/* Fire test payload */}
          <div>
            <div class="text-[12px] font-medium text-[var(--color-text)] mb-1.5">
              Fire test payload
            </div>
            <div class="text-[11px] text-[var(--color-text-faint)] mb-2">
              Posts the JSON below through this watcher's actions in test mode.
              Uses dashboard auth, no HMAC required for the test path.
            </div>
            <textarea
              value={testJson}
              onInput={(e) => setTestJson((e.target as HTMLTextAreaElement).value)}
              rows={6}
              class="w-full text-[12px] font-mono p-2 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
              data-testid={`test-json-${watcher.slug}`}
            />
            <div class="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={fireTest}
                disabled={firing}
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
                data-testid={`fire-test-${watcher.slug}`}
              >
                <PlayCircle size={13} /> {firing ? 'Firing…' : 'Fire test'}
              </button>
              {lastResult && (
                <span class="text-[11.5px] text-[var(--color-text-muted)]">{lastResult}</span>
              )}
            </div>
          </div>

          {/* Last payloads */}
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <div class="text-[12px] font-medium text-[var(--color-text)]">Last payloads</div>
              <button
                type="button"
                onClick={refreshPayloads}
                class="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                Refresh
              </button>
            </div>
            {loadingPayloads && <div class="text-[11.5px] text-[var(--color-text-muted)]">Loading…</div>}
            {!loadingPayloads && payloads && payloads.length === 0 && (
              <div class="text-[11.5px] text-[var(--color-text-faint)] py-3">
                No payloads received yet.
              </div>
            )}
            {!loadingPayloads && payloads && payloads.length > 0 && (
              <div class="space-y-1.5" data-testid={`payloads-${watcher.slug}`}>
                {payloads.map((p) => (
                  <PayloadRow key={p.id} row={p} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PayloadRow({ row }: { row: WebhookPayloadRow }) {
  const [open, setOpen] = useState(false);
  let prettyPayload = row.payload_json;
  try { prettyPayload = JSON.stringify(JSON.parse(row.payload_json), null, 2); } catch { /* keep raw */ }
  return (
    <div class="border border-[var(--color-border)] rounded p-2 bg-[var(--color-elevated)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        class="w-full flex items-center gap-2 text-left"
      >
        <span class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums w-12">#{row.id}</span>
        <Pill tone={row.mode === 'run' ? 'done' : row.mode === 'preview' ? 'accent' : 'neutral'}>
          {row.mode}
        </Pill>
        <Pill tone={row.signature_valid ? 'done' : 'failed'}>
          {row.signature_valid ? 'signed' : 'unsigned'}
        </Pill>
        <span class="text-[11px] text-[var(--color-text-muted)] flex-1 truncate">
          {row.remote_ip || 'unknown'}
        </span>
        <span class="text-[11px] text-[var(--color-text-faint)] tabular-nums">
          {formatRelativeTime(row.received_at)}
        </span>
      </button>
      {open && (
        <pre class="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all bg-[var(--color-card)] border border-[var(--color-border)] rounded p-2 max-h-64 overflow-auto">
          {prettyPayload}
        </pre>
      )}
    </div>
  );
}

// ── Create / Edit modal ───────────────────────────────────────────────────
//
// Shared form for creating a new webhook watcher and editing an existing
// one. Slice 8 limits the action editor to a single `queue-mission`
// action — covering the 80% case where a webhook just queues a mission
// task on a specific agent. Multi-action / conditional / send-slack
// editing lands in a follow-up slice; until then, an operator drops to
// watchers.yaml directly for those.
//
// Existing watchers whose actions don't fit the queue-mission shape
// stay editable for name/secret_env/mode but show a notice that their
// actions list isn't editable here (preserves the data — we never null
// it out from the form).

interface QueueMissionAction {
  agent: string;
  title: string;
  prompt: string;
  silent_start: boolean;
  silent_result: boolean;
}

function extractQueueMission(actions: unknown[]): QueueMissionAction | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const first = actions[0] as Record<string, unknown>;
  if (!first || typeof first !== 'object') return null;
  const qm = first['queue-mission'];
  if (!qm || typeof qm !== 'object') return null;
  const x = qm as Record<string, unknown>;
  return {
    agent: typeof x.agent === 'string' ? x.agent : '',
    title: typeof x.title === 'string' ? x.title : '',
    prompt: typeof x.prompt === 'string' ? x.prompt : '',
    silent_start: x.silent_start === true,
    silent_result: x.silent_result === true,
  };
}

function isSimpleQueueMissionList(actions: unknown[]): boolean {
  return Array.isArray(actions) && actions.length === 1 && extractQueueMission(actions) !== null;
}

interface AgentLite { id: string; name: string }

function WatcherFormModal({
  open, existing, onClose, onSaved,
}: {
  open: boolean;
  existing: WebhookWatcher | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = existing !== null;
  const agents = useFetch<{ agents: AgentLite[] }>(open ? '/api/agents' : null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [secretEnv, setSecretEnv] = useState('');
  const [mode, setMode] = useState<'test' | 'preview' | 'run'>('test');
  const [actionAgent, setActionAgent] = useState('main');
  const [actionTitle, setActionTitle] = useState('');
  const [actionPrompt, setActionPrompt] = useState('');
  const [actionSilentStart, setActionSilentStart] = useState(false);
  const [actionSilentResult, setActionSilentResult] = useState(false);
  const [advancedActionsLocked, setAdvancedActionsLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed form when existing changes or modal re-opens.
  useEffect(() => {
    if (!open) return;
    if (existing) {
      setName(existing.name);
      setSlug(existing.slug);
      setSecretEnv(existing.secret_env);
      setMode(existing.mode);
      const qm = extractQueueMission(existing.actions);
      if (qm && isSimpleQueueMissionList(existing.actions)) {
        setActionAgent(qm.agent || 'main');
        setActionTitle(qm.title);
        setActionPrompt(qm.prompt);
        setActionSilentStart(qm.silent_start);
        setActionSilentResult(qm.silent_result);
        setAdvancedActionsLocked(false);
      } else {
        // Existing actions list is more complex than the simple form
        // can edit. Lock the actions section so save preserves the
        // existing list verbatim.
        setActionAgent('main');
        setActionTitle('');
        setActionPrompt('');
        setActionSilentStart(false);
        setActionSilentResult(false);
        setAdvancedActionsLocked(true);
      }
    } else {
      setName('');
      setSlug('');
      setSecretEnv('');
      setMode('test');
      setActionAgent('main');
      setActionTitle('');
      setActionPrompt('');
      setActionSilentStart(false);
      setActionSilentResult(false);
      setAdvancedActionsLocked(false);
    }
    setErr(null);
  }, [open, existing?.slug]);

  // Auto-derive slug from name on create — only until the user edits the
  // slug field manually. Doesn't touch slug while editing an existing
  // watcher (slug is immutable on PUT).
  function handleNameChange(v: string) {
    setName(v);
    if (!isEdit) {
      const auto = v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      // Only sync slug if the current slug looks auto-derived (stays in sync until user types).
      if (slug === '' || slug === name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)) {
        setSlug(auto);
      }
    }
  }

  const slugValid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
  const envValid = /^[A-Z][A-Z0-9_]*$/.test(secretEnv);
  const actionValid = advancedActionsLocked
    ? true
    : (actionAgent.trim().length > 0 && actionTitle.trim().length > 0 && actionPrompt.trim().length > 0);
  const formValid =
    name.trim().length > 0 &&
    slugValid &&
    envValid &&
    actionValid;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // Build the actions list. If the existing watcher had a complex
      // (non-queue-mission-only) action list, preserve it verbatim — we
      // never want this slice's simplified editor to clobber the YAML's
      // multi-step routing.
      const qmEntry: Record<string, unknown> = {
        agent: actionAgent.trim(),
        title: actionTitle.trim(),
        prompt: actionPrompt.trim(),
      };
      if (actionSilentStart) qmEntry.silent_start = true;
      if (actionSilentResult) qmEntry.silent_result = true;
      const actions: unknown[] = advancedActionsLocked && existing
        ? existing.actions
        : [{ 'queue-mission': qmEntry }];

      if (isEdit && existing) {
        await apiPut(`/api/watchers/${existing.slug}`, {
          name: name.trim(),
          secret_env: secretEnv.trim(),
          mode,
          actions,
        });
        pushToast({ tone: 'success', title: 'Webhook updated' });
      } else {
        await apiPost('/api/watchers', {
          type: 'webhook',
          name: name.trim(),
          slug: slug.trim(),
          secret_env: secretEnv.trim(),
          mode,
          actions,
        });
        pushToast({ tone: 'success', title: 'Webhook created' });
      }
      onSaved();
      onClose();
    } catch (e: any) {
      const msg = e?.body?.error || e?.message || String(e);
      setErr(msg);
      pushToast({ tone: 'error', title: 'Save failed', description: msg, durationMs: 7000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={isEdit ? 'Edit triggered task' : 'New triggered task'}
      width={620}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            class="px-3 py-1.5 rounded text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !formValid}
            data-testid="watcher-form-save"
            class="ml-auto px-3 py-1.5 rounded text-[12.5px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create')}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-4">
        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onInput={(e) => handleNameChange((e.target as HTMLInputElement).value)}
            data-testid="watcher-form-name"
            class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]"
          />
        </div>

        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Slug {isEdit && <span class="text-[var(--color-text-faint)]">(immutable)</span>}
          </label>
          <input
            type="text"
            value={slug}
            disabled={isEdit}
            onInput={(e) => setSlug((e.target as HTMLInputElement).value.toLowerCase())}
            data-testid="watcher-form-slug"
            placeholder="lowercase, dashes, 1–64 chars"
            class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] font-mono disabled:opacity-50"
          />
          {!slugValid && slug.length > 0 && (
            <div class="text-[10.5px] text-[var(--color-status-failed)] mt-1">
              Slug must be lowercase a–z, 0–9, or dashes (1–64 chars).
            </div>
          )}
          <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1 font-mono">
            URL: /api/watchers/webhook/{slug || '<slug>'}
          </div>
        </div>

        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Secret env var
          </label>
          <input
            type="text"
            value={secretEnv}
            onInput={(e) => setSecretEnv((e.target as HTMLInputElement).value.toUpperCase())}
            data-testid="watcher-form-secret-env"
            placeholder="e.g. MY_WEBHOOK_SECRET"
            class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] font-mono"
          />
          {!envValid && secretEnv.length > 0 && (
            <div class="text-[10.5px] text-[var(--color-status-failed)] mt-1">
              Must look like an env var: uppercase letters, digits, underscores.
            </div>
          )}
          <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1">
            Set the actual secret in <span class="font-mono">.env</span>. Bot will load it on next request (no restart).
          </div>
        </div>

        <div>
          <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
            Mode
          </label>
          <div class="flex gap-2" data-testid="watcher-form-mode">
            {(['test', 'preview', 'run'] as const).map((m) => (
              <label
                key={m}
                class={[
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded border cursor-pointer transition-colors',
                  mode === m
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-[var(--color-accent)]'
                    : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)]',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="watcher-form-mode-radio"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  class="sr-only"
                  data-testid={`watcher-form-mode-${m}`}
                />
                <span class="text-[12px] font-medium">{m}</span>
              </label>
            ))}
          </div>
          <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1">
            <span class="font-mono">test</span>: HMAC required, fires actions, tagged as test. <span class="font-mono">preview</span>: HMAC required, payload captured, no actions. <span class="font-mono">run</span>: live.
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)]">
              Action: queue-mission
            </label>
          </div>
          {advancedActionsLocked ? (
            <div class="text-[11.5px] text-[var(--color-text-muted)] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-2.5 leading-relaxed">
              This watcher's actions list is more complex than this dialog can edit (e.g. <span class="font-mono">lookup-owner</span> or <span class="font-mono">if-owned</span> branches). Name, secret_env, and mode are still editable. To change the actions, edit <span class="font-mono">watchers.yaml</span> directly.
            </div>
          ) : (
            <div class="space-y-2 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3">
              <div>
                <div class="text-[10.5px] text-[var(--color-text-faint)] mb-1">Agent</div>
                <select
                  value={actionAgent}
                  onInput={(e) => setActionAgent((e.target as HTMLSelectElement).value)}
                  data-testid="watcher-form-action-agent"
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
                <div class="text-[10.5px] text-[var(--color-text-faint)] mb-1">Mission title</div>
                <input
                  type="text"
                  value={actionTitle}
                  onInput={(e) => setActionTitle((e.target as HTMLInputElement).value)}
                  placeholder='e.g. "New signal received ({slug})"'
                  data-testid="watcher-form-action-title"
                  class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]"
                />
              </div>
              <div>
                <div class="text-[10.5px] text-[var(--color-text-faint)] mb-1">Prompt template</div>
                <textarea
                  value={actionPrompt}
                  onInput={(e) => setActionPrompt((e.target as HTMLTextAreaElement).value)}
                  rows={5}
                  placeholder="Use {payload.x} or {payload_raw} to reference the inbound webhook body."
                  data-testid="watcher-form-action-prompt"
                  class="w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] font-mono resize-y"
                />
              </div>
              <label class="flex items-start gap-2 cursor-pointer select-none pt-1">
                <input
                  type="checkbox"
                  checked={actionSilentStart}
                  onChange={(e) => setActionSilentStart((e.target as HTMLInputElement).checked)}
                  class="mt-0.5 cursor-pointer accent-[var(--color-accent)]"
                />
                <span class="flex-1">
                  <span class="block text-[12px] text-[var(--color-text)]">Silent start</span>
                  <span class="block text-[10.5px] text-[var(--color-text-faint)] leading-snug mt-0.5">
                    Don't pre-announce when this fires. (Mission tasks have no pre-announce yet — set anyway for forward-compat.)
                  </span>
                </span>
              </label>
              <label class="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={actionSilentResult}
                  onChange={(e) => setActionSilentResult((e.target as HTMLInputElement).checked)}
                  class="mt-0.5 cursor-pointer accent-[var(--color-accent)]"
                />
                <span class="flex-1">
                  <span class="block text-[12px] text-[var(--color-text)]">Silent result</span>
                  <span class="block text-[10.5px] text-[var(--color-text-faint)] leading-snug mt-0.5">
                    Suppress the result message on Telegram. Output saves to Mission Control. Errors and timeouts still ping.
                  </span>
                </span>
              </label>
            </div>
          )}
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
