import { useState } from 'preact/hooks';
import { Webhook, Copy, Check, PlayCircle, ChevronRight, ChevronDown } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import { apiGet, apiPost } from '@/lib/api';
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

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Triggered Tasks"
        actions={
          <span class="text-[11px] text-[var(--color-text-muted)]">
            {watchers.length} webhook{watchers.length === 1 ? '' : 's'}
          </span>
        }
      />

      {list.error && <PageState error={list.error} />}
      {list.loading && !list.data && <PageState loading />}

      {!list.loading && !list.error && watchers.length === 0 && (
        <PageState
          empty
          emptyTitle="No webhook watchers configured"
          emptyDescription="Add a `webhook` entry to watchers.yaml to get started."
        />
      )}

      <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {watchers.map((w) => (
          <WatcherCard key={w.slug} watcher={w} onChange={list.refresh} />
        ))}
      </div>
    </div>
  );
}

// ── Per-watcher card ────────────────────────────────────────────────────

function WatcherCard({ watcher, onChange }: { watcher: WebhookWatcher; onChange: () => void }) {
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
