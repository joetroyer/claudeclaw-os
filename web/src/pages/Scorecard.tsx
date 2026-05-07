/**
 * Slice 5 — Performance Scorecard.
 *
 * Two views: "Scorecard" (per-agent metrics) and "Budget" (LOB / project
 * rollups). Both read /api/scorecard and /api/budget with a shared
 * window selector (1d / 7d / 30d / 90d / all).
 *
 * Subscription platforms render a "subscription" badge instead of $0
 * so a flat-fee Claude Max agent isn't misread as "no spend".
 *
 * This is its own top-level page, NOT a tab on the org chart — Slice 3
 * is being built in parallel and would conflict. Slice 3 owner is free
 * to absorb this page later.
 */
import { useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import { formatCost, formatNumber } from '@/lib/format';

type Window = '1d' | '7d' | '30d' | '90d' | 'all';
type View = 'scorecard' | 'budget';

interface ScorecardRow {
  agent_id: string;
  name: string;
  description: string;
  model: string | null;
  platform: string;
  lob: string;
  projects: string[];
  ideal: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  subscription_flag: 0 | 1;
  recordedCostUsd: number;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  completionRate: number | null;
  avgDurationSec: number | null;
  avgTokensPerTask: number | null;
  avgCostPerTask: number | null;
}

interface ScorecardResponse {
  window: Window;
  generatedAt: number;
  rows: ScorecardRow[];
}

interface BudgetGroup {
  key: string;
  label: string;
  costUsd: number;
  totalTokens: number;
  turns: number;
  agents: string[];
  hasSubscription: boolean;
}

interface BudgetResponse {
  window: Window;
  generatedAt: number;
  byLob: BudgetGroup[];
  byProject: BudgetGroup[];
}

const WINDOW_LABELS: Record<Window, string> = {
  '1d': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  'all': 'all',
};

export function Scorecard({ initialView = 'scorecard' }: { initialView?: View } = {}) {
  const [window, setWindow] = useState<Window>('30d');
  const [view, setView] = useState<View>(initialView);
  const [selectedLob, setSelectedLob] = useState<string | null>(null);

  const sc = useFetch<ScorecardResponse>(`/api/scorecard?window=${window}`, 60_000);
  const bg = useFetch<BudgetResponse>(`/api/budget?window=${window}`, 60_000);

  const scRows = sc.data?.rows ?? [];
  const bgLob = bg.data?.byLob ?? [];
  const bgProj = bg.data?.byProject ?? [];

  const error = sc.error || bg.error;
  const loading = (sc.loading || bg.loading) && !sc.data && !bg.data;

  // When a LOB chip is selected, filter the project list to projects
  // touched by agents in that LOB. Empty selection = show all.
  const filteredProjects = selectedLob === null
    ? bgProj
    : bgProj.filter((p) => p.agents.some((id) => {
        const row = scRows.find((r) => r.agent_id === id);
        const lobKey = row?.lob && row.lob.trim() ? row.lob.trim() : 'Unassigned';
        return lobKey === selectedLob;
      }));

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Scorecard"
        actions={
          <WindowPicker value={window} onChange={setWindow} />
        }
        tabs={
          <div class="flex items-center gap-1" role="tablist" aria-label="Scorecard view">
            <ViewTab active={view === 'scorecard'} onClick={() => setView('scorecard')}>By agent</ViewTab>
            <ViewTab active={view === 'budget'} onClick={() => setView('budget')}>By LOB / project</ViewTab>
          </div>
        }
      />

      {error && <PageState error={error} />}
      {!error && loading && <PageState loading />}

      {!error && !loading && view === 'scorecard' && (
        <div class="flex-1 overflow-y-auto p-6">
          <ScorecardTable rows={scRows} />
        </div>
      )}

      {!error && !loading && view === 'budget' && (
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          <BudgetSection
            title="By line of business"
            groups={bgLob}
            selected={selectedLob}
            onSelect={setSelectedLob}
          />
          <BudgetSection
            title={selectedLob ? `By project — filtered to ${selectedLob}` : 'By project'}
            groups={filteredProjects}
            selected={null}
          />
        </div>
      )}
    </div>
  );
}

function WindowPicker({ value, onChange }: { value: Window; onChange: (w: Window) => void }) {
  const opts: Window[] = ['1d', '7d', '30d', '90d', 'all'];
  return (
    <div class="inline-flex items-center gap-0.5 bg-[var(--color-card)] border border-[var(--color-border)] rounded p-0.5">
      {opts.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          class={
            'px-2 py-0.5 text-[11px] rounded ' +
            (w === value
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-medium'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]')
          }
        >
          {WINDOW_LABELS[w]}
        </button>
      ))}
    </div>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      class={
        'px-3 py-1.5 text-[12px] rounded-t border-b-2 ' +
        (active
          ? 'border-[var(--color-accent)] text-[var(--color-text)] font-medium'
          : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]')
      }
    >
      {children}
    </button>
  );
}

function ScorecardTable({ rows }: { rows: ScorecardRow[] }) {
  if (rows.length === 0) {
    return (
      <div class="text-[12px] text-[var(--color-text-muted)] p-8 text-center bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg">
        No agent activity in this window. Run a turn or queue a mission task to see metrics.
      </div>
    );
  }
  return (
    <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg overflow-x-auto">
      <table class="w-full text-[12px] tabular-nums">
        <thead class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
          <tr class="border-b border-[var(--color-border)]">
            <th class="text-left px-4 py-2 font-medium">Agent</th>
            <th class="text-left px-3 py-2 font-medium">Platform</th>
            <th class="text-right px-3 py-2 font-medium">Turns</th>
            <th class="text-right px-3 py-2 font-medium">Tokens</th>
            <th class="text-right px-3 py-2 font-medium">Cost</th>
            <th class="text-right px-3 py-2 font-medium">Tasks</th>
            <th class="text-right px-3 py-2 font-medium">Completion</th>
            <th class="text-right px-3 py-2 font-medium">Avg / task</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent_id} class="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-elevated)]">
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-[var(--color-text)]">{r.name}</span>
                  {r.ideal && <Pill tone="neutral">ideal</Pill>}
                </div>
                <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5">
                  {r.lob || 'unassigned LOB'}
                  {r.projects.length > 0 && ' · ' + r.projects.join(', ')}
                </div>
              </td>
              <td class="px-3 py-2.5 text-[var(--color-text-muted)]">
                <div>{r.platform || '—'}</div>
                {r.model && <div class="text-[10.5px] text-[var(--color-text-faint)]">{r.model.replace('claude-', '')}</div>}
              </td>
              <td class="px-3 py-2.5 text-right">{formatNumber(r.turns)}</td>
              <td class="px-3 py-2.5 text-right">{formatNumber(r.totalTokens)}</td>
              <td class="px-3 py-2.5 text-right">
                {r.subscription_flag === 1
                  ? <Pill tone="accent">subscription</Pill>
                  : formatCost(r.costUsd)}
              </td>
              <td class="px-3 py-2.5 text-right">
                {r.tasksTotal > 0 ? (
                  <span>
                    {r.tasksCompleted}
                    <span class="text-[var(--color-text-faint)]">/{r.tasksTotal}</span>
                  </span>
                ) : (
                  <span class="text-[var(--color-text-faint)]">—</span>
                )}
              </td>
              <td class="px-3 py-2.5 text-right">
                {r.completionRate === null
                  ? <span class="text-[var(--color-text-faint)]">—</span>
                  : Math.round(r.completionRate * 100) + '%'}
              </td>
              <td class="px-3 py-2.5 text-right text-[var(--color-text-muted)]">
                {r.avgTokensPerTask !== null
                  ? formatNumber(r.avgTokensPerTask) + ' tok'
                  : <span class="text-[var(--color-text-faint)]">—</span>}
                {r.avgCostPerTask !== null && (
                  <div class="text-[10.5px] text-[var(--color-text-faint)]">{formatCost(r.avgCostPerTask)}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BudgetSection({
  title, groups, selected, onSelect,
}: {
  title: string;
  groups: BudgetGroup[];
  selected: string | null;
  onSelect?: (key: string | null) => void;
}) {
  if (groups.length === 0) {
    return (
      <div>
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">{title}</div>
        <div class="text-[12px] text-[var(--color-text-muted)] p-6 text-center bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg">
          No data in this window.
        </div>
      </div>
    );
  }
  const totalCost = groups.reduce((a, g) => a + g.costUsd, 0);
  return (
    <div>
      <div class="flex items-center justify-between mb-2">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{title}</div>
        <div class="text-[10px] text-[var(--color-text-muted)] tabular-nums">total {formatCost(totalCost)}</div>
      </div>
      <div class="grid gap-2 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => {
          const isSelected = selected === g.key;
          const clickable = !!onSelect;
          return (
            <button
              key={g.key}
              type="button"
              onClick={clickable
                ? () => onSelect!(isSelected ? null : g.key)
                : undefined}
              class={
                'text-left bg-[var(--color-card)] border rounded-lg p-3 transition-colors ' +
                (isSelected
                  ? 'border-[var(--color-accent)]'
                  : 'border-[var(--color-border)] ' + (clickable ? 'hover:border-[var(--color-text-faint)]' : ''))
              }
            >
              <div class="flex items-center justify-between gap-2 mb-1">
                <div class="text-[12.5px] font-medium text-[var(--color-text)] truncate">{g.label}</div>
                {g.hasSubscription && <Pill tone="accent">subscription</Pill>}
              </div>
              <div class="text-[18px] font-semibold tabular-nums text-[var(--color-text)]">
                {formatCost(g.costUsd)}
              </div>
              <div class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums">
                {formatNumber(g.totalTokens)} tokens · {g.turns} turns · {g.agents.length} {g.agents.length === 1 ? 'agent' : 'agents'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
