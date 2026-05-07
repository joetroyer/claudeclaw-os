import { useEffect, useMemo, useState } from 'preact/hooks';
import { ChevronRight, AlertTriangle, Sparkles } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Drawer } from '@/components/Modal';
import { Pill } from '@/components/Pill';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useFetch } from '@/lib/useFetch';

// ── shared types — mirror server-side shapes from src/org-chart.ts ───

interface LobProject { slug: string; name: string; }
interface Lob {
  slug: string;
  name: string;
  description: string;
  projects: LobProject[];
}
interface Human {
  id: string;
  name: string;
  role: string;
  owns_lobs: string[];
  owns_projects: string[];
}
interface OrgAgent {
  id: string;
  name: string;
  description: string;
  lob: string;
  projects: string[];
  ideal: boolean;
  platform: string;
  four_rs_results: string[];
  skills_primary: string[];
  owns: {
    scheduled_tasks: string[];
    triggered_tasks: string[];
    n8n_workflows: string[];
    watchers: string[];
  };
  avatar: string;
}
interface AgentWorkload {
  agent_id: string;
  mission_tasks: number;
  scheduled_tasks: number;
  total: number;
  overloaded: boolean;
  suggested_breakout: string | null;
}

type TabKey = 'hierarchy' | 'analytics' | 'ideal-vs-active';

// "Selected" pointer for the hierarchy drill-down. Null = top-level
// LOB grid; { lob } = projects inside that LOB; { lob, project } =
// resource list inside that project.
type Selection =
  | { kind: 'root' }
  | { kind: 'lob'; lobSlug: string }
  | { kind: 'project'; lobSlug: string; projectSlug: string };

// Synthetic slug used to bucket agents whose `lob:` field is empty or
// references a slug not present in lobs.yaml. The same slug is reused
// at the project level for agents inside a real LOB whose `projects:`
// list references unknown project slugs (or is empty).
const UNASSIGNED_SLUG = '__unassigned__';

// ── page ─────────────────────────────────────────────────────────────

export function OrgChart() {
  const [tab, setTab] = useState<TabKey>('hierarchy');
  const [selection, setSelection] = useState<Selection>({ kind: 'root' });
  const [drawer, setDrawer] = useState<
    | { kind: 'agent'; id: string }
    | { kind: 'human'; id: string }
    | null
  >(null);

  const lobs = useFetch<{ lobs: Lob[] }>('/api/org-chart/lobs', 60_000);
  const humans = useFetch<{ humans: Human[] }>('/api/org-chart/humans', 60_000);
  const agents = useFetch<{ agents: OrgAgent[] }>('/api/org-chart/agents', 60_000);
  const workload = useFetch<{
    window_days: number;
    overload_threshold: number;
    workload: AgentWorkload[];
  }>('/api/org-chart/workload', 60_000);

  const lobList = lobs.data?.lobs ?? [];
  const humanList = humans.data?.humans ?? [];
  const agentList = agents.data?.agents ?? [];
  const workloadList = workload.data?.workload ?? [];

  const loading =
    lobs.loading || humans.loading || agents.loading || workload.loading;
  const error =
    lobs.error || humans.error || agents.error || workload.error;

  // Reset selection when an upstream config change makes the current
  // pointer dangle (e.g. a LOB is renamed/removed). The synthetic
  // "Unassigned" bucket (UNASSIGNED_SLUG) is always considered valid
  // when there are agents to populate it; the same applies to the
  // "Unassigned" project inside a real LOB.
  useEffect(() => {
    if (selection.kind === 'lob' || selection.kind === 'project') {
      if (selection.lobSlug === UNASSIGNED_SLUG) {
        // Stays valid as long as there's at least one unassigned agent.
        const hasUnassigned = agentList.some(
          (a) => !a.lob || !lobList.some((l) => l.slug === a.lob),
        );
        if (!hasUnassigned) setSelection({ kind: 'root' });
        return;
      }
      const lob = lobList.find((l) => l.slug === selection.lobSlug);
      if (!lob) {
        setSelection({ kind: 'root' });
        return;
      }
      if (selection.kind === 'project' && selection.projectSlug !== UNASSIGNED_SLUG) {
        const proj = lob.projects.find((p) => p.slug === selection.projectSlug);
        if (!proj) setSelection({ kind: 'lob', lobSlug: lob.slug });
      }
    }
  }, [lobList, agentList]);

  const drawerAgent =
    drawer?.kind === 'agent' ? agentList.find((a) => a.id === drawer.id) : null;
  const drawerHuman =
    drawer?.kind === 'human' ? humanList.find((h) => h.id === drawer.id) : null;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Org Chart"
        tabs={
          <>
            <Tab label="Hierarchy" active={tab === 'hierarchy'} onClick={() => setTab('hierarchy')} />
            <Tab
              label="Analytics"
              active={tab === 'analytics'}
              onClick={() => setTab('analytics')}
              count={workloadList.filter((w) => w.overloaded).length}
            />
            <Tab
              label="Ideal vs Active"
              active={tab === 'ideal-vs-active'}
              onClick={() => setTab('ideal-vs-active')}
              count={agentList.filter((a) => a.ideal).length}
            />
          </>
        }
      />

      {error && <PageState error={error} />}
      {loading && !lobs.data && <PageState loading />}

      {!loading && !error && tab === 'hierarchy' && (
        <HierarchyView
          lobs={lobList}
          humans={humanList}
          agents={agentList}
          selection={selection}
          onSelect={setSelection}
          onOpenAgent={(id) => setDrawer({ kind: 'agent', id })}
          onOpenHuman={(id) => setDrawer({ kind: 'human', id })}
        />
      )}

      {!loading && !error && tab === 'analytics' && (
        <AnalyticsView
          agents={agentList}
          workload={workloadList}
          windowDays={workload.data?.window_days ?? 30}
          threshold={workload.data?.overload_threshold ?? 20}
          onOpenAgent={(id) => setDrawer({ kind: 'agent', id })}
        />
      )}

      {!loading && !error && tab === 'ideal-vs-active' && (
        <IdealVsActiveView
          agents={agentList}
          onOpenAgent={(id) => setDrawer({ kind: 'agent', id })}
        />
      )}

      <Drawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        title={
          drawerAgent ? `${drawerAgent.name}` :
          drawerHuman ? `${drawerHuman.name}` :
          'Details'
        }
      >
        {drawerAgent && <AgentDrawer agent={drawerAgent} />}
        {drawerHuman && <HumanDrawer human={drawerHuman} />}
      </Drawer>
    </div>
  );
}

// ── Hierarchy ────────────────────────────────────────────────────────

function HierarchyView({
  lobs, humans, agents, selection, onSelect, onOpenAgent, onOpenHuman,
}: {
  lobs: Lob[];
  humans: Human[];
  agents: OrgAgent[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onOpenAgent: (id: string) => void;
  onOpenHuman: (id: string) => void;
}) {
  // Build the rendered LOB list: configured LOBs + a synthetic
  // "Unassigned" bucket whenever any agent's `lob:` is empty or
  // references a slug that doesn't exist in lobs.yaml. This keeps the
  // page from going blank when nobody has filled in `lob:` yet (every
  // agent ships with `lob: ""` after Slice 1 by default).
  const knownLobSlugs = useMemo(() => new Set(lobs.map((l) => l.slug)), [lobs]);
  const unassignedAgents = useMemo(
    () => agents.filter((a) => !a.lob || !knownLobSlugs.has(a.lob)),
    [agents, knownLobSlugs],
  );
  const renderLobs: Lob[] = useMemo(() => {
    if (unassignedAgents.length === 0) return lobs;
    return [
      ...lobs,
      {
        slug: UNASSIGNED_SLUG,
        name: 'Unassigned',
        description: 'Configure `lob:` in agent.yaml to place these on the chart.',
        projects: [],
      },
    ];
  }, [lobs, unassignedAgents]);

  // Helper: list the agents that belong inside a (possibly synthetic)
  // LOB. The unassigned bucket collects every agent whose lob is empty
  // or unknown.
  function agentsForLob(lobSlug: string): OrgAgent[] {
    if (lobSlug === UNASSIGNED_SLUG) return unassignedAgents;
    return agents.filter((a) => a.lob === lobSlug);
  }

  // No LOBs configured AND no agents at all — show the original empty
  // state. With at least one agent, the unassigned bucket carries the
  // page so we never hand the user a blank screen.
  if (renderLobs.length === 0) {
    return (
      <PageState
        empty
        emptyTitle="No LOBs configured"
        emptyDescription="Add lines of business to lobs.yaml at the project root, then refresh."
      />
    );
  }

  if (selection.kind === 'root') {
    return (
      <div class="flex-1 overflow-y-auto p-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {renderLobs.map((lob) => {
            const lobAgents = agentsForLob(lob.slug);
            const lobHumans = lob.slug === UNASSIGNED_SLUG
              ? []
              : humans.filter((h) => h.owns_lobs.includes(lob.slug));
            const isUnassigned = lob.slug === UNASSIGNED_SLUG;
            return (
              <button
                key={lob.slug}
                type="button"
                data-testid={`lob-card-${lob.slug}`}
                onClick={() => onSelect({ kind: 'lob', lobSlug: lob.slug })}
                class={[
                  'text-left p-4 rounded-lg border bg-[var(--color-card)] hover:bg-[var(--color-elevated)] transition-colors',
                  isUnassigned
                    ? 'border-dashed border-[var(--color-border)]'
                    : 'border-[var(--color-border)]',
                ].join(' ')}
              >
                <div class="text-[14px] font-semibold text-[var(--color-text)]">{lob.name}</div>
                {lob.description && (
                  <div class="text-[12px] text-[var(--color-text-muted)] mt-1">{lob.description}</div>
                )}
                <div class="mt-3 flex items-center gap-2 text-[11px] text-[var(--color-text-faint)]">
                  <span>{lob.projects.length} project{lob.projects.length === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>{lobAgents.length} agent{lobAgents.length === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>{lobHumans.length} human{lobHumans.length === 1 ? '' : 's'}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (selection.kind === 'lob') {
    const lob = renderLobs.find((l) => l.slug === selection.lobSlug);
    if (!lob) {
      // Defensive — selection useEffect should have already reset.
      return (
        <PageState
          empty
          emptyTitle="LOB not found"
          emptyDescription="The selected LOB is no longer in lobs.yaml."
        />
      );
    }
    const isUnassigned = lob.slug === UNASSIGNED_SLUG;
    const lobAgents = agentsForLob(lob.slug);
    const lobHumans = isUnassigned
      ? []
      : humans.filter((h) => h.owns_lobs.includes(lob.slug));

    // Inside a real LOB, partition agents into known projects + an
    // "Unassigned" project bucket for any agent whose `projects:` is
    // empty or references slugs that don't exist on this LOB.
    const knownProjectSlugs = new Set(lob.projects.map((p) => p.slug));
    const projectUnassignedAgents = isUnassigned
      ? []
      : lobAgents.filter(
          (a) =>
            a.projects.length === 0 ||
            !a.projects.some((slug) => knownProjectSlugs.has(slug)),
        );
    const renderProjects: LobProject[] = projectUnassignedAgents.length > 0
      ? [...lob.projects, { slug: UNASSIGNED_SLUG, name: 'Unassigned' }]
      : lob.projects;

    return (
      <div class="flex-1 overflow-y-auto p-6">
        <Breadcrumb
          parts={[{ label: 'LOBs', onClick: () => onSelect({ kind: 'root' }) }, { label: lob.name }]}
        />
        <h2 class="text-[15px] font-semibold text-[var(--color-text)] mt-3">{lob.name}</h2>
        {lob.description && (
          <p class="text-[12px] text-[var(--color-text-muted)] mt-1">{lob.description}</p>
        )}
        {isUnassigned && (
          <p class="text-[12px] text-[var(--color-text-faint)] mt-1">
            Agents with an empty or unrecognized <code class="text-[11px]">lob:</code> field land here. Edit each agent's <code class="text-[11px]">agent.yaml</code> to place them on the chart.
          </p>
        )}

        {!isUnassigned && (
          <div class="mt-5">
            <div class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Projects</div>
            {renderProjects.length === 0 ? (
              <div class="text-[12px] text-[var(--color-text-muted)]">No projects defined for this LOB.</div>
            ) : (
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {renderProjects.map((proj) => {
                  const projAgents = proj.slug === UNASSIGNED_SLUG
                    ? projectUnassignedAgents
                    : lobAgents.filter((a) => a.projects.includes(proj.slug));
                  const projIsUnassigned = proj.slug === UNASSIGNED_SLUG;
                  return (
                    <button
                      key={proj.slug}
                      type="button"
                      data-testid={`project-card-${proj.slug}`}
                      onClick={() => onSelect({ kind: 'project', lobSlug: lob.slug, projectSlug: proj.slug })}
                      class={[
                        'text-left p-3 rounded-md border bg-[var(--color-card)] hover:bg-[var(--color-elevated)] transition-colors',
                        projIsUnassigned
                          ? 'border-dashed border-[var(--color-border)]'
                          : 'border-[var(--color-border)]',
                      ].join(' ')}
                    >
                      <div class="flex items-center gap-2">
                        <div class="text-[13px] font-medium text-[var(--color-text)]">{proj.name}</div>
                        <ChevronRight size={14} class="ml-auto text-[var(--color-text-faint)]" />
                      </div>
                      <div class="mt-1 text-[11px] text-[var(--color-text-faint)]">
                        {projAgents.length} agent{projAgents.length === 1 ? '' : 's'}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div class="mt-6">
          <div class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">All resources in {lob.name}</div>
          <ResourceList
            agents={lobAgents}
            humans={lobHumans}
            onOpenAgent={onOpenAgent}
            onOpenHuman={onOpenHuman}
          />
        </div>
      </div>
    );
  }

  // selection.kind === 'project'
  const lob = renderLobs.find((l) => l.slug === selection.lobSlug);
  if (!lob) {
    return (
      <PageState
        empty
        emptyTitle="LOB not found"
        emptyDescription="The selected LOB is no longer in lobs.yaml."
      />
    );
  }
  const isUnassignedLob = lob.slug === UNASSIGNED_SLUG;
  const isUnassignedProject = selection.projectSlug === UNASSIGNED_SLUG;
  const proj: LobProject | undefined = isUnassignedProject
    ? { slug: UNASSIGNED_SLUG, name: 'Unassigned' }
    : lob.projects.find((p) => p.slug === selection.projectSlug);
  if (!proj) {
    return (
      <PageState
        empty
        emptyTitle="Project not found"
        emptyDescription="The selected project is no longer in lobs.yaml."
      />
    );
  }

  // Agents shown for this project view:
  //   - Unassigned LOB: not reachable here (no projects), but defensive.
  //   - Unassigned project under a real LOB: agents whose projects[]
  //     is empty or references unknown slugs.
  //   - Real project: agents whose projects[] includes the slug.
  const lobAgents = agentsForLob(lob.slug);
  const knownProjectSlugs = new Set(lob.projects.map((p) => p.slug));
  const projAgents = isUnassignedProject
    ? lobAgents.filter(
        (a) =>
          a.projects.length === 0 ||
          !a.projects.some((slug) => knownProjectSlugs.has(slug)),
      )
    : lobAgents.filter((a) => a.projects.includes(proj.slug));
  const projHumans = isUnassignedLob || isUnassignedProject
    ? []
    : humans.filter(
        (h) => h.owns_lobs.includes(lob.slug) || h.owns_projects.includes(proj.slug),
      );
  return (
    <div class="flex-1 overflow-y-auto p-6">
      <Breadcrumb
        parts={[
          { label: 'LOBs', onClick: () => onSelect({ kind: 'root' }) },
          { label: lob.name, onClick: () => onSelect({ kind: 'lob', lobSlug: lob.slug }) },
          { label: proj.name },
        ]}
      />
      <h2 class="text-[15px] font-semibold text-[var(--color-text)] mt-3">{proj.name}</h2>
      <div class="text-[12px] text-[var(--color-text-muted)] mt-1">In {lob.name}</div>
      {isUnassignedProject && (
        <p class="text-[12px] text-[var(--color-text-faint)] mt-1">
          Agents whose <code class="text-[11px]">projects:</code> list is empty or references unknown slugs. Edit <code class="text-[11px]">agent.yaml</code> to assign them to a project on this LOB.
        </p>
      )}

      <div class="mt-5">
        <div class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">Assigned resources</div>
        <ResourceList
          agents={projAgents}
          humans={projHumans}
          onOpenAgent={onOpenAgent}
          onOpenHuman={onOpenHuman}
        />
      </div>
    </div>
  );
}

function Breadcrumb({ parts }: { parts: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <div class="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
      {parts.map((p, i) => (
        <span key={i} class="flex items-center gap-2">
          {p.onClick ? (
            <button type="button" onClick={p.onClick} class="hover:text-[var(--color-text)] transition-colors">
              {p.label}
            </button>
          ) : (
            <span class="text-[var(--color-text)]">{p.label}</span>
          )}
          {i < parts.length - 1 && <span class="text-[var(--color-text-faint)]">›</span>}
        </span>
      ))}
    </div>
  );
}

function ResourceList({
  agents, humans, onOpenAgent, onOpenHuman,
}: {
  agents: OrgAgent[];
  humans: Human[];
  onOpenAgent: (id: string) => void;
  onOpenHuman: (id: string) => void;
}) {
  if (agents.length === 0 && humans.length === 0) {
    return <div class="text-[12px] text-[var(--color-text-muted)]">Nobody assigned yet.</div>;
  }
  return (
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          data-testid={`agent-card-${a.id}`}
          onClick={() => onOpenAgent(a.id)}
          class="text-left p-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] hover:bg-[var(--color-elevated)] transition-colors flex items-center gap-3"
        >
          <AgentAvatar agentId={a.id} name={a.name} size={32} />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <div class="text-[13px] font-medium text-[var(--color-text)] truncate">{a.name}</div>
              {a.ideal && <Pill tone="medium">ideal</Pill>}
            </div>
            <div class="text-[11px] text-[var(--color-text-muted)] truncate">{a.description || 'agent'}</div>
          </div>
        </button>
      ))}
      {humans.map((h) => (
        <button
          key={h.id}
          type="button"
          data-testid={`human-card-${h.id}`}
          onClick={() => onOpenHuman(h.id)}
          class="text-left p-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] hover:bg-[var(--color-elevated)] transition-colors flex items-center gap-3"
        >
          <div class="w-8 h-8 rounded-full bg-[var(--color-elevated)] text-[var(--color-text-muted)] flex items-center justify-center text-[12px] font-semibold">
            {h.name.split(/\s+/).map((p) => p[0] || '').join('').slice(0, 2).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <div class="text-[13px] font-medium text-[var(--color-text)] truncate">{h.name}</div>
              <Pill tone="neutral">human</Pill>
            </div>
            <div class="text-[11px] text-[var(--color-text-muted)] truncate">{h.role || 'team member'}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Analytics ────────────────────────────────────────────────────────

function AnalyticsView({
  agents, workload, windowDays, threshold, onOpenAgent,
}: {
  agents: OrgAgent[];
  workload: AgentWorkload[];
  windowDays: number;
  threshold: number;
  onOpenAgent: (id: string) => void;
}) {
  const byId = useMemo(() => {
    const map = new Map<string, OrgAgent>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const sorted = [...workload].sort((a, b) => b.total - a.total);
  const max = sorted[0]?.total ?? 0;
  const overloaded = sorted.filter((w) => w.overloaded);

  return (
    <div class="flex-1 overflow-y-auto p-6">
      <div class="flex items-baseline justify-between mb-4">
        <div>
          <h2 class="text-[14px] font-semibold text-[var(--color-text)]">Workload analytics</h2>
          <p class="text-[12px] text-[var(--color-text-muted)] mt-1">
            Tasks per agent over the last {windowDays}d. Overload threshold: {threshold}.
          </p>
        </div>
      </div>

      {overloaded.length > 0 && (
        <div
          class="mb-5 p-3 rounded-md border border-[var(--color-status-failed)] bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)]"
          data-testid="overload-banner"
        >
          <div class="flex items-center gap-2 text-[13px] font-medium text-[var(--color-status-failed)]">
            <AlertTriangle size={14} />
            {overloaded.length} agent{overloaded.length === 1 ? '' : 's'} flagged as overloaded
          </div>
          <ul class="mt-2 space-y-1 text-[12px] text-[var(--color-text-muted)]">
            {overloaded.map((w) => (
              <li key={w.agent_id}>
                <span class="text-[var(--color-text)] font-medium">{byId.get(w.agent_id)?.name || w.agent_id}</span>:
                {' '}{w.suggested_breakout}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sorted.length === 0 ? (
        <PageState
          empty
          emptyTitle="No agents to analyze"
          emptyDescription="Add agents to agents/ and they'll show up here."
        />
      ) : (
        <div class="space-y-2">
          {sorted.map((w) => {
            const a = byId.get(w.agent_id);
            const pct = max > 0 ? Math.round((w.total / max) * 100) : 0;
            return (
              <button
                key={w.agent_id}
                type="button"
                data-testid={`workload-row-${w.agent_id}`}
                onClick={() => onOpenAgent(w.agent_id)}
                class="w-full text-left p-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] hover:bg-[var(--color-elevated)] transition-colors"
              >
                <div class="flex items-center gap-3">
                  <AgentAvatar agentId={w.agent_id} name={a?.name} size={28} />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="text-[13px] font-medium text-[var(--color-text)] truncate">
                        {a?.name || w.agent_id}
                      </div>
                      {w.overloaded && <Pill tone="failed">overloaded</Pill>}
                    </div>
                    <div class="mt-2 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
                      <div
                        class="h-full bg-[var(--color-accent)]"
                        style={{ width: pct + '%' }}
                      />
                    </div>
                  </div>
                  <div class="text-right shrink-0 ml-3">
                    <div class="text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{w.total}</div>
                    <div class="text-[10px] text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">
                      {w.mission_tasks}m · {w.scheduled_tasks}s
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Ideal vs Active ──────────────────────────────────────────────────

function IdealVsActiveView({
  agents, onOpenAgent,
}: {
  agents: OrgAgent[];
  onOpenAgent: (id: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'active' | 'ideal'>('all');

  const filtered = agents.filter((a) => {
    if (filter === 'active') return !a.ideal;
    if (filter === 'ideal') return a.ideal;
    return true;
  });
  const idealCount = agents.filter((a) => a.ideal).length;
  const activeCount = agents.length - idealCount;

  return (
    <div class="flex-1 overflow-y-auto p-6">
      <div class="flex items-baseline justify-between mb-4">
        <div>
          <h2 class="text-[14px] font-semibold text-[var(--color-text)]">Ideal vs Active</h2>
          <p class="text-[12px] text-[var(--color-text-muted)] mt-1">
            Mapped on the org chart but not yet built. Editing an agent's <code class="text-[11px] text-[var(--color-text-muted)]">ideal: true</code> in agent.yaml flips its status here.
          </p>
        </div>
        <div class="inline-flex bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-0.5 text-[12px]">
          <FilterBtn label={`All (${agents.length})`} active={filter === 'all'} onClick={() => setFilter('all')} />
          <FilterBtn label={`Active (${activeCount})`} active={filter === 'active'} onClick={() => setFilter('active')} />
          <FilterBtn label={`Ideal (${idealCount})`} active={filter === 'ideal'} onClick={() => setFilter('ideal')} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <PageState
          empty
          emptyTitle={filter === 'ideal' ? 'No ideal agents mapped' : 'No agents in this view'}
          emptyDescription={filter === 'ideal' ? 'Set ideal: true on an agent.yaml to plan it without spinning it up.' : 'Try a different filter.'}
        />
      ) : (
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((a) => (
            <button
              key={a.id}
              type="button"
              data-testid={`ideal-card-${a.id}`}
              onClick={() => onOpenAgent(a.id)}
              class={[
                'text-left p-3 rounded-md border bg-[var(--color-card)] hover:bg-[var(--color-elevated)] transition-colors',
                a.ideal ? 'border-dashed border-[var(--color-priority-medium)]' : 'border-[var(--color-border)]',
              ].join(' ')}
            >
              <div class="flex items-center gap-3">
                <AgentAvatar agentId={a.id} name={a.name} size={32} />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <div class="text-[13px] font-medium text-[var(--color-text)] truncate">{a.name}</div>
                    {a.ideal ? (
                      <Pill tone="medium">
                        <span class="inline-flex items-center gap-1">
                          <Sparkles size={10} /> ideal
                        </span>
                      </Pill>
                    ) : (
                      <Pill tone="neutral">active</Pill>
                    )}
                  </div>
                  <div class="text-[11px] text-[var(--color-text-muted)] truncate">{a.description || 'agent'}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={[
        'px-2.5 py-1 rounded transition-colors',
        active
          ? 'bg-[var(--color-card)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

// ── Drawers ──────────────────────────────────────────────────────────

function AgentDrawer({ agent }: { agent: OrgAgent }) {
  const ownsAny =
    agent.owns.scheduled_tasks.length +
    agent.owns.triggered_tasks.length +
    agent.owns.n8n_workflows.length +
    agent.owns.watchers.length;
  return (
    <div class="px-6 py-4 space-y-5">
      <div class="flex items-center gap-3">
        <AgentAvatar agentId={agent.id} name={agent.name} size={48} />
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="text-[15px] font-semibold text-[var(--color-text)] truncate">{agent.name}</h3>
            {agent.ideal && <Pill tone="medium">ideal</Pill>}
          </div>
          <div class="text-[12px] text-[var(--color-text-muted)] truncate">{agent.description}</div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-faint)]">
            {agent.lob && <span>LOB: {agent.lob}</span>}
            {agent.platform && <span>· platform: {agent.platform}</span>}
          </div>
        </div>
      </div>

      <Section title="Four Rs — Results">
        {agent.four_rs_results.length === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">No measurable Results captured yet.</p>
        ) : (
          <ul class="text-[12px] text-[var(--color-text)] space-y-1 list-disc pl-5">
            {agent.four_rs_results.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </Section>

      <Section title="Primary skills">
        {agent.skills_primary.length === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">None highlighted.</p>
        ) : (
          <div class="flex flex-wrap gap-1.5">
            {agent.skills_primary.map((s) => (
              <span key={s} class="px-2 py-0.5 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
                {s}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Projects">
        {agent.projects.length === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">None assigned.</p>
        ) : (
          <div class="flex flex-wrap gap-1.5">
            {agent.projects.map((p) => (
              <span key={p} class="px-2 py-0.5 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
                {p}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Owns">
        {ownsAny === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">No ownership pointers set.</p>
        ) : (
          <div class="space-y-2 text-[12px]">
            <OwnsRow label="Scheduled tasks" items={agent.owns.scheduled_tasks} />
            <OwnsRow label="Triggered tasks" items={agent.owns.triggered_tasks} />
            <OwnsRow label="n8n workflows" items={agent.owns.n8n_workflows} />
            <OwnsRow label="Watchers" items={agent.owns.watchers} />
          </div>
        )}
      </Section>
    </div>
  );
}

function OwnsRow({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
      <div class="flex flex-wrap gap-1.5 mt-1">
        {items.map((it) => (
          <span key={it} class="px-2 py-0.5 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

function HumanDrawer({ human }: { human: Human }) {
  return (
    <div class="px-6 py-4 space-y-5">
      <div>
        <div class="flex items-center gap-2">
          <h3 class="text-[15px] font-semibold text-[var(--color-text)]">{human.name}</h3>
          <Pill tone="neutral">human</Pill>
        </div>
        <div class="text-[12px] text-[var(--color-text-muted)]">{human.role || 'team member'}</div>
      </div>

      <Section title="Owns LOBs">
        {human.owns_lobs.length === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">None assigned.</p>
        ) : (
          <div class="flex flex-wrap gap-1.5">
            {human.owns_lobs.map((l) => (
              <span key={l} class="px-2 py-0.5 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
                {l}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title="Owns projects">
        {human.owns_projects.length === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">None assigned.</p>
        ) : (
          <div class="flex flex-wrap gap-1.5">
            {human.owns_projects.map((p) => (
              <span key={p} class="px-2 py-0.5 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
                {p}
              </span>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div>
      <div class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">{title}</div>
      {children}
    </div>
  );
}
