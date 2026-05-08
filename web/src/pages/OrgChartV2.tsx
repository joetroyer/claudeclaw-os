// Slice 10 Wave 1 — OrgChartV2 page.
//
// A navigable IDE for the org. AI nodes can sit at any tier; humans and
// AI share an identical card schema (only the type badge differs). The
// page reads the Wave 0 endpoint /api/org-chart-v2 and renders a tree of
// cards with smart collapse/expand, focus mode, depth presets, search,
// filter chips, URL state, and per-card outbound links.
//
// See proof/slice-10/wave-0/api-org-chart-v2-sample.json for the exact
// shape of nodes returned by the endpoint. The page never mutates the
// server payload — all interaction state (expansion, focus, filters,
// search) lives in component state plus localStorage + URL params.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import {
  Search, X, ChevronDown, ChevronRight, MoreHorizontal,
  Calendar, Zap, User, Bot, Filter,
} from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Drawer } from '@/components/Modal';
import { Pill } from '@/components/Pill';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useFetch } from '@/lib/useFetch';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';
import { apiGet, apiPut, ApiError } from '@/lib/api';
import jsyaml from 'js-yaml';

// ── types ────────────────────────────────────────────────────────────

interface FourRs {
  role: string;
  responsibilities: string[];
  results: string[];
  requirements: string[];
}

interface Personality {
  tone: string;
  pushback: string;
  format: string;
}

interface Skills {
  primary: string[];
}

interface Owns {
  scheduled_tasks: string[];
  triggered_tasks: string[];
  n8n_workflows: string[];
  watchers: string[];
}

interface OrgNode {
  id: string;
  type: 'human' | 'ai';
  name: string;
  role: string;
  reports_to: string | null;
  lob: string | null;
  projects: string[];
  skills: Skills;
  owns: Owns;
  four_rs: FourRs;
  personality: Personality;
  avatar: string | null;
  running: boolean | null;
  today_turns: number | null;
  scheduled_count: number;
  triggered_count: number;
}

interface OrgChartV2Response {
  nodes: OrgNode[];
}

type TypeFilter = 'all' | 'human' | 'ai';

const STORAGE_KEY = 'claudeclaw.org-chart-v2.expansion';

// ── localStorage helpers ─────────────────────────────────────────────

function loadExpansion(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.map(String));
  } catch {
    // ignore — stale or unparseable state, just start fresh
  }
  return new Set();
}

function saveExpansion(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // best-effort; private mode / quota — non-fatal
  }
}

// ── tree helpers ─────────────────────────────────────────────────────

interface TreeNode extends OrgNode {
  children: TreeNode[];
  depth: number;
}

// Build a forest from the flat node list. Roots are nodes whose
// reports_to is null OR whose parent does not exist in the set (defensive
// — orphans become roots so the page never silently loses a card).
function buildTree(nodes: OrgNode[]): { roots: TreeNode[]; byId: Map<string, TreeNode> } {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [], depth: 0 });
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    const tn = byId.get(n.id)!;
    const parent = n.reports_to ? byId.get(n.reports_to) : null;
    if (parent) parent.children.push(tn);
    else roots.push(tn);
  }
  // Recursively assign depth.
  function setDepth(n: TreeNode, d: number) {
    n.depth = d;
    for (const c of n.children) setDepth(c, d + 1);
  }
  for (const r of roots) setDepth(r, 0);
  // Stable sort: humans first, then AI; alphabetical within type.
  function sortNode(n: TreeNode) {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'human' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) sortNode(c);
  }
  for (const r of roots) sortNode(r);
  return { roots, byId };
}

// All descendant ids of a node (excluding the node itself).
function descendantIds(node: TreeNode): string[] {
  const out: string[] = [];
  function walk(n: TreeNode) {
    for (const c of n.children) {
      out.push(c.id);
      walk(c);
    }
  }
  walk(node);
  return out;
}

// All ancestor ids of a node id, walking up reports_to.
function ancestorIds(id: string, byId: Map<string, TreeNode>): string[] {
  const out: string[] = [];
  let cur = byId.get(id);
  while (cur && cur.reports_to) {
    const parent = byId.get(cur.reports_to);
    if (!parent) break;
    out.push(parent.id);
    cur = parent;
  }
  return out;
}

// Collect ids whose subtree (or self) matches the filter predicate.
// Used by search and chip filters: a node matches if itself matches OR
// any descendant matches (so the path stays visible/highlighted).
function nodesMatching(roots: TreeNode[], pred: (n: TreeNode) => boolean): Set<string> {
  const out = new Set<string>();
  function walk(n: TreeNode): boolean {
    let any = pred(n);
    for (const c of n.children) {
      if (walk(c)) any = true;
    }
    if (any) out.add(n.id);
    return any;
  }
  for (const r of roots) walk(r);
  return out;
}

// ── focus trap hook ──────────────────────────────────────────────────
//
// When `active` flips true, save document.activeElement, focus the first
// focusable child of `containerRef`, then while active intercept Tab /
// Shift-Tab keydown to cycle focus inside the container. When active
// flips false, restore focus to the previously focused element.
//
// Inline (not extracted) per-page because the codebase has no shared
// focus-trap util and the spec for this slice forbids new dependencies.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function useFocusTrap(
  containerRef: { current: HTMLElement | null },
  active: boolean,
) {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    // Save the element that had focus when the trap activated so we can
    // restore it on deactivation (e.g. card title that opened the drawer).
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null;

    // Focus the first focusable inside the container on next tick so the
    // container has been rendered.
    const timer = window.setTimeout(() => {
      const root = containerRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (first) first.focus();
    }, 0);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) {
        // Nothing to focus inside; swallow Tab so it can't escape.
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !root.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !root.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus when the trap deactivates. Guard against the
      // previously-focused element being detached from the DOM.
      const prev = previouslyFocusedRef.current;
      if (prev && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [active]);
}

// ── URL state helpers ────────────────────────────────────────────────

function readUrlState(): { focus: string | null; expand: string[] | null } {
  if (typeof window === 'undefined') return { focus: null, expand: null };
  const url = new URL(window.location.href);
  const focus = url.searchParams.get('focus');
  const expandRaw = url.searchParams.get('expand');
  const expand = expandRaw
    ? expandRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  return { focus, expand };
}

function writeUrlState(focus: string | null, expand: string[] | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (focus) url.searchParams.set('focus', focus);
  else url.searchParams.delete('focus');
  if (expand && expand.length > 0) url.searchParams.set('expand', expand.join(','));
  else url.searchParams.delete('expand');
  window.history.replaceState(null, '', url.toString());
}

// ── page ─────────────────────────────────────────────────────────────

export function OrgChartV2() {
  const { data, loading, error, refresh } = useFetch<OrgChartV2Response>('/api/org-chart-v2', 60_000);
  const [, navigate] = useLocation();
  // Slice 10 Wave 3 — when a node id is in `editingYamlId`, the drawer
  // body swaps to YamlEditorPanel for that node. Cleared on Save success
  // (drawer closes too) or Cancel (returns to read-only drawer view).
  const [editingYamlId, setEditingYamlId] = useState<string | null>(null);

  const nodes = data?.nodes ?? [];
  const { roots, byId } = useMemo(() => buildTree(nodes), [nodes]);

  // Load initial state from URL + localStorage. URL wins on conflict so
  // shared links land you on the right view regardless of stored state.
  const initial = useMemo(() => readUrlState(), []);
  const [focusId, setFocusId] = useState<string | null>(initial.focus);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (initial.expand && initial.expand.length > 0) return new Set(initial.expand);
    const stored = loadExpansion();
    if (stored.size > 0) return stored;
    // Default: top 2 levels expanded — i.e. root nodes are "open".
    return new Set();
  });
  // Track whether we've applied default open-state. We open all roots by
  // default if no stored / URL state told us otherwise. This runs once
  // after the initial fetch resolves.
  const defaultedRef = useRef(false);
  useEffect(() => {
    if (defaultedRef.current) return;
    if (roots.length === 0) return;
    if (initial.expand && initial.expand.length > 0) {
      defaultedRef.current = true;
      return;
    }
    const stored = loadExpansion();
    if (stored.size > 0) {
      defaultedRef.current = true;
      return;
    }
    // Default expansion: every root open (depth-2 visible).
    setExpanded(new Set(roots.map((r) => r.id)));
    defaultedRef.current = true;
  }, [roots]);

  // Persist expansion to localStorage.
  useEffect(() => {
    saveExpansion(expanded);
  }, [expanded]);

  // Persist URL state on focus / expand changes. Search and filter chips
  // are intentionally NOT mirrored to URL — they're transient view
  // helpers, not bookmarkable state.
  useEffect(() => {
    writeUrlState(focusId, Array.from(expanded));
  }, [focusId, expanded]);

  // Search.
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebouncedValue(searchRaw, 200);
  const [savedExpansion, setSavedExpansion] = useState<Set<string> | null>(null);
  // When search becomes non-empty: snapshot the current expansion so we
  // can restore on clear, then auto-expand the path to every match.
  useEffect(() => {
    const q = search.trim().toLowerCase();
    if (q) {
      if (savedExpansion === null) setSavedExpansion(new Set(expanded));
      const matches = nodesMatching(roots, (n) =>
        n.name.toLowerCase().includes(q) ||
        n.role.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q),
      );
      // Expand every ancestor of every match so the path is visible.
      const next = new Set(expanded);
      for (const id of matches) {
        next.add(id);
        for (const a of ancestorIds(id, byId)) next.add(a);
      }
      setExpanded(next);
    } else if (savedExpansion !== null) {
      setExpanded(savedExpansion);
      setSavedExpansion(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const matchSet = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return nodesMatching(roots, (n) =>
      n.name.toLowerCase().includes(q) ||
      n.role.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q),
    );
  }, [search, roots]);

  // Filter chips. Type, LOB, project. Active filters dim non-matching
  // branches but don't hide them — see CardShell for the dim styling.
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [lobFilter, setLobFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const filterPredicate = useMemo(() => {
    const hasFilter = typeFilter !== 'all' || lobFilter !== null || projectFilter !== null;
    if (!hasFilter) return null;
    return (n: OrgNode) => {
      if (typeFilter !== 'all' && n.type !== typeFilter) return false;
      if (lobFilter !== null && n.lob !== lobFilter) return false;
      if (projectFilter !== null && !n.projects.includes(projectFilter)) return false;
      return true;
    };
  }, [typeFilter, lobFilter, projectFilter]);

  const filterMatchSet = useMemo(() => {
    if (!filterPredicate) return null;
    return nodesMatching(roots, filterPredicate);
  }, [filterPredicate, roots]);

  // Drawer. Focus trap activates while open and restores focus on close.
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const drawerNode = drawerId ? byId.get(drawerId) ?? null : null;
  const drawerContentRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerContentRef, drawerNode !== null);

  // Available LOBs and projects for filter dropdowns.
  const lobOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.lob) set.add(n.lob);
    return Array.from(set).sort();
  }, [nodes]);
  const projectOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) for (const p of n.projects) set.add(p);
    return Array.from(set).sort();
  }, [nodes]);

  // Depth-preset toolbar action: expand every node up to (depth) levels.
  function applyDepth(depth: number | 'all') {
    const next = new Set<string>();
    function walk(n: TreeNode) {
      const limit = depth === 'all' ? Infinity : depth - 1;
      if (n.depth <= limit) next.add(n.id);
      for (const c of n.children) walk(c);
    }
    for (const r of roots) walk(r);
    setExpanded(next);
    // A depth reset cancels focus mode — the user is asking for a global
    // view, not a zoom.
    setFocusId(null);
  }

  // Focus mode: when focused, only the focused node's subtree is shown
  // (siblings collapse). The rendering layer enforces this; this helper
  // also ensures the focused subtree is fully expanded.
  function enterFocus(id: string) {
    setFocusId(id);
    const node = byId.get(id);
    if (!node) return;
    const next = new Set<string>();
    next.add(id);
    for (const a of ancestorIds(id, byId)) next.add(a);
    for (const d of descendantIds(node)) next.add(d);
    setExpanded(next);
    // Pulse the card so the eye lands on it.
    requestAnimationFrame(() => pulseCard(id));
  }
  function exitFocus() {
    setFocusId(null);
  }

  // Toggle a node's "open" state (chevron click).
  function toggleNode(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Bulk: open every descendant under id.
  function expandAllUnder(id: string) {
    const node = byId.get(id);
    if (!node) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(id);
      for (const d of descendantIds(node)) next.add(d);
      return next;
    });
  }

  // Bulk: close every sibling at this node's depth (under same parent).
  function collapseSiblings(id: string) {
    const node = byId.get(id);
    if (!node) return;
    const parentId = node.reports_to;
    setExpanded((prev) => {
      const next = new Set(prev);
      let siblings: TreeNode[];
      if (parentId === null) siblings = roots.filter((r) => r.id !== id);
      else {
        const parent = byId.get(parentId);
        siblings = parent ? parent.children.filter((c) => c.id !== id) : [];
      }
      for (const s of siblings) {
        next.delete(s.id);
        for (const d of descendantIds(s)) next.delete(d);
      }
      return next;
    });
  }

  // Card title click: focus mode. Card subtitle (role) click: open drawer.
  // Keyboard: Enter on title triggers focus, Space on a row toggles expand.
  function copyLink(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('focus', id);
    url.searchParams.delete('expand');
    navigator.clipboard.writeText(url.toString())
      .then(() => pushToast({ tone: 'success', title: 'Link copied' }))
      .catch(() => pushToast({ tone: 'error', title: 'Copy failed' }));
  }

  // Click a node link inside the drawer (parent / child) — closes the
  // drawer, scrolls + pulses the card.
  function jumpTo(id: string) {
    setDrawerId(null);
    enterFocus(id);
  }

  // Visible children helper. In focus mode, only the focus's subtree is
  // visible at the root level; everything else is hidden. Filter dimming
  // is layered on top via CSS.
  function rootsToRender(): TreeNode[] {
    if (!focusId) return roots;
    const focused = byId.get(focusId);
    return focused ? [focused] : roots;
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Org Chart v2"
        actions={
          <div class="flex items-center gap-2">
            <DepthPresets onPick={applyDepth} />
          </div>
        }
      />

      <Toolbar
        searchRaw={searchRaw}
        onSearch={setSearchRaw}
        typeFilter={typeFilter}
        onType={setTypeFilter}
        lobFilter={lobFilter}
        onLob={setLobFilter}
        lobOptions={lobOptions}
        projectFilter={projectFilter}
        onProject={setProjectFilter}
        projectOptions={projectOptions}
        focusId={focusId}
        onExitFocus={exitFocus}
        focusName={focusId ? byId.get(focusId)?.name ?? null : null}
      />

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}

      {!loading && !error && roots.length === 0 && (
        <PageState
          empty
          emptyTitle="No nodes found"
          emptyDescription="The /api/org-chart-v2 endpoint returned an empty list."
        />
      )}

      {!loading && !error && roots.length > 0 && (
        <div
          class="flex-1 overflow-y-auto org-chart-canvas-scroll p-3 sm:p-4"
          onClick={(e) => {
            // Click on the empty background (not on a card) exits focus.
            if (e.target === e.currentTarget && focusId) exitFocus();
          }}
          data-testid="org-chart-v2-canvas"
        >
          {/* Slice 10 Wave 4 — horizontal sibling layout. The tree fans
              out wide; we let the canvas grow as wide as it needs and
              scroll horizontally for big rows rather than wrapping
              (wrapping breaks the connector-bus visualization). */}
          <div class="inline-flex flex-col items-center min-w-full">
            <div class="flex flex-row items-start justify-center gap-6">
              {rootsToRender().map((r) => (
                <NodeBranch
                  key={r.id}
                  node={r}
                  expanded={expanded}
                  matchSet={matchSet}
                  filterMatchSet={filterMatchSet}
                  onToggle={toggleNode}
                  onTitle={enterFocus}
                  onSubtitle={(id) => setDrawerId(id)}
                  onAvatar={(id) => navigate(`/agents/${encodeURIComponent(id)}`)}
                  onTypeBadge={(t) => setTypeFilter(t)}
                  onScheduled={(id) => navigate(`/scheduled?agent=${encodeURIComponent(id)}`)}
                  onTriggered={(id) => navigate(`/triggered?agent=${encodeURIComponent(id)}`)}
                  onMenu={{
                    copyLink,
                    expandAllUnder,
                    collapseSiblings,
                    focus: enterFocus,
                    editYaml: (id: string) => { setDrawerId(id); setEditingYamlId(id); },
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <Drawer
        open={drawerNode !== null}
        onClose={() => { setDrawerId(null); setEditingYamlId(null); }}
        title={drawerNode ? drawerNode.name : 'Details'}
      >
        {drawerNode && (
          <div ref={drawerContentRef} data-testid="org-chart-v2-drawer-content">
            {editingYamlId === drawerNode.id ? (
              <YamlEditorPanel
                node={drawerNode}
                onCancel={() => setEditingYamlId(null)}
                onSaved={() => {
                  setEditingYamlId(null);
                  setDrawerId(null);
                  refresh();
                }}
              />
            ) : (
              <NodeDrawer
                node={drawerNode}
                byId={byId}
                onJumpTo={jumpTo}
                onSkill={(slug) => navigate(`/skills/${encodeURIComponent(slug)}`)}
                onScheduled={(slug) => navigate(`/scheduled?id=${encodeURIComponent(slug)}`)}
                onTriggered={(slug) => navigate(`/triggered?slug=${encodeURIComponent(slug)}`)}
                onLob={(lob) => { setLobFilter(lob); setDrawerId(null); }}
                onProject={(p) => { setProjectFilter(p); setDrawerId(null); }}
                onYamlEdit={() => setEditingYamlId(drawerNode.id)}
              />
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// ── pulse helper (mirrors scrollToKanbanTask in MissionControl) ──────

function pulseCard(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.querySelector(`[data-org-node-id="${CSS.escape(id)}"]`) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('kanban-pulse');
  window.setTimeout(() => el.classList.remove('kanban-pulse'), 1600);
}

// ── toolbar ──────────────────────────────────────────────────────────

interface ToolbarProps {
  searchRaw: string;
  onSearch: (s: string) => void;
  typeFilter: TypeFilter;
  onType: (t: TypeFilter) => void;
  lobFilter: string | null;
  onLob: (l: string | null) => void;
  lobOptions: string[];
  projectFilter: string | null;
  onProject: (p: string | null) => void;
  projectOptions: string[];
  focusId: string | null;
  onExitFocus: () => void;
  focusName: string | null;
}

function Toolbar(p: ToolbarProps) {
  return (
    <div
      class="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]"
      data-testid="org-chart-v2-toolbar"
    >
      {/* Search — MissionControl-style: leading magnifying glass, slim
          input, focus ring uses the app accent. */}
      <div class="relative flex-1 min-w-[160px] max-w-[260px]">
        <Search
          size={12}
          class="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none"
          data-testid="org-chart-v2-search-icon"
        />
        <input
          type="text"
          placeholder="Search org chart…"
          class="w-full min-h-[44px] bg-[var(--color-card)] border border-[var(--color-border)] rounded pl-7 pr-7 py-1.5 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-accent)] transition-colors"
          value={p.searchRaw}
          onInput={(e) => p.onSearch((e.target as HTMLInputElement).value)}
          data-testid="org-chart-v2-search"
        />
        {p.searchRaw && (
          <button
            type="button"
            class="absolute right-1 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            onClick={() => p.onSearch('')}
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Type-filter pills — inline, slim, no leading icon (the labels
          already imply the filter). */}
      <div class="flex items-center gap-1 text-[11px]">
        <FilterChip
          label="All"
          active={p.typeFilter === 'all'}
          onClick={() => p.onType('all')}
          testid="org-chart-v2-filter-type-all"
        />
        <FilterChip
          label={<span class="inline-flex items-center gap-1"><User size={10} /> Human</span>}
          active={p.typeFilter === 'human'}
          onClick={() => p.onType('human')}
          testid="org-chart-v2-filter-type-human"
        />
        <FilterChip
          label={<span class="inline-flex items-center gap-1"><Bot size={10} /> AI</span>}
          active={p.typeFilter === 'ai'}
          onClick={() => p.onType('ai')}
          testid="org-chart-v2-filter-type-ai"
        />
      </div>

      {p.lobOptions.length > 0 && (
        <select
          class="text-[11px] min-h-[44px] px-2 py-1.5 rounded bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
          value={p.lobFilter ?? ''}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            p.onLob(v ? v : null);
          }}
          data-testid="org-chart-v2-filter-lob"
        >
          <option value="">All LOBs</option>
          {p.lobOptions.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      )}

      {p.projectOptions.length > 0 && (
        <select
          class="text-[11px] min-h-[44px] px-2 py-1.5 rounded bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
          value={p.projectFilter ?? ''}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            p.onProject(v ? v : null);
          }}
          data-testid="org-chart-v2-filter-project"
        >
          <option value="">All projects</option>
          {p.projectOptions.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
        </select>
      )}

      {p.focusId && (
        <button
          type="button"
          onClick={p.onExitFocus}
          class="ml-auto inline-flex items-center gap-1 px-2 py-1.5 min-h-[44px] rounded text-[11px] bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:opacity-90"
          data-testid="org-chart-v2-exit-focus"
        >
          <X size={11} />
          Exit focus: {p.focusName ?? p.focusId}
        </button>
      )}
    </div>
  );
}

function FilterChip({
  label, active, onClick, testid,
}: {
  label: any;
  active: boolean;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      class={[
        // Min 44x44 touch target per WCAG 2.5.5 (Level AAA) /
        // Apple HIG. Visual padding is tight; the size is hit-area only.
        'min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-2.5 py-1.5 rounded text-[11px] transition-colors',
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function DepthPresets({ onPick }: { onPick: (d: number | 'all') => void }) {
  return (
    <div class="inline-flex items-center gap-0.5 bg-[var(--color-card)] border border-[var(--color-border)] rounded p-0.5 text-[11px]">
      <span class="px-1.5 text-[var(--color-text-faint)] text-[10px] uppercase tracking-wider">Depth</span>
      {[1, 2, 3].map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onPick(d)}
          class="min-h-[44px] min-w-[36px] inline-flex items-center justify-center px-2 py-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          data-testid={`org-chart-v2-depth-${d}`}
        >
          {d}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPick('all')}
        class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-2 py-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
        data-testid="org-chart-v2-depth-all"
      >
        All
      </button>
    </div>
  );
}

// ── tree branch (recursive) ──────────────────────────────────────────

interface BranchProps {
  node: TreeNode;
  expanded: Set<string>;
  matchSet: Set<string> | null;
  filterMatchSet: Set<string> | null;
  onToggle: (id: string) => void;
  onTitle: (id: string) => void;
  onSubtitle: (id: string) => void;
  onAvatar: (id: string) => void;
  onTypeBadge: (t: TypeFilter) => void;
  onScheduled: (id: string) => void;
  onTriggered: (id: string) => void;
  onMenu: {
    copyLink: (id: string) => void;
    expandAllUnder: (id: string) => void;
    collapseSiblings: (id: string) => void;
    focus: (id: string) => void;
    editYaml: (id: string) => void;
  };
}

function NodeBranch(p: BranchProps) {
  const isOpen = p.expanded.has(p.node.id);
  const hasChildren = p.node.children.length > 0;
  const dimmed = (() => {
    if (p.filterMatchSet && !p.filterMatchSet.has(p.node.id)) return true;
    if (p.matchSet && !p.matchSet.has(p.node.id)) return true;
    return false;
  })();
  const highlighted = !!p.matchSet?.has(p.node.id);

  // Slice 10 Wave 4 — horizontal sibling layout. Each subtree is a
  // flex column: parent card on top, a short vertical trunk, then a
  // flex row of children. The pseudo-elements on .org-chart-child draw
  // the horizontal bus + short verticals down to each child card.
  return (
    <div class="org-chart-subtree">
      <NodeCard
        node={p.node}
        isOpen={isOpen}
        hasChildren={hasChildren}
        dimmed={dimmed}
        highlighted={highlighted}
        onToggle={() => p.onToggle(p.node.id)}
        onTitle={() => p.onTitle(p.node.id)}
        onSubtitle={() => p.onSubtitle(p.node.id)}
        onAvatar={() => p.onAvatar(p.node.id)}
        onTypeBadge={() => p.onTypeBadge(p.node.type)}
        onScheduled={() => p.onScheduled(p.node.id)}
        onTriggered={() => p.onTriggered(p.node.id)}
        onMenu={p.onMenu}
      />
      {isOpen && hasChildren && (
        <>
          <div class="org-chart-trunk" aria-hidden="true" />
          <div
            class="org-chart-children-row"
            data-testid={`org-chart-v2-children-${p.node.id}`}
          >
            {p.node.children.map((c) => (
              <div key={c.id} class="org-chart-child">
                <NodeBranch {...p} node={c} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── card ─────────────────────────────────────────────────────────────

interface CardProps {
  node: TreeNode;
  isOpen: boolean;
  hasChildren: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onToggle: () => void;
  onTitle: () => void;
  onSubtitle: () => void;
  onAvatar: () => void;
  onTypeBadge: () => void;
  onScheduled: () => void;
  onTriggered: () => void;
  onMenu: {
    copyLink: (id: string) => void;
    expandAllUnder: (id: string) => void;
    collapseSiblings: (id: string) => void;
    focus: (id: string) => void;
    editYaml: (id: string) => void;
  };
}

function NodeCard(p: CardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const reportCount = p.node.children.length;
  const aiReportCount = p.node.children.filter((c) => c.type === 'ai').length;
  const humanReportCount = reportCount - aiReportCount;
  const scheduled = p.node.scheduled_count || p.node.owns.scheduled_tasks.length || 0;
  const triggered = p.node.triggered_count || p.node.owns.triggered_tasks.length || 0;

  const isHuman = p.node.type === 'human';
  const primarySkills = p.node.skills?.primary ?? [];
  const visibleSkills = primarySkills.slice(0, 3);
  // Slice 10 Wave 4 — Four-Rs preview. First responsibility line below
  // the role gives the eye a glance of what this node actually does
  // without opening the drawer. Truncated to ~50 chars to keep cards
  // dense; the full list lives in the drawer.
  const firstResp =
    Array.isArray(p.node.four_rs?.responsibilities) && p.node.four_rs.responsibilities.length > 0
      ? p.node.four_rs.responsibilities[0]
      : '';

  // Slice 10 Wave 4 — compact 240px card form factor. Targets ~5
  // siblings per row at 1280px and a two-row card height. Mobile keeps
  // a fluid full-width fallback under 400px so cards don't get clipped.
  return (
    <div
      class={[
        'org-chart-card relative rounded-lg border bg-[var(--color-card)] transition-all shadow-sm',
        'w-[240px] max-w-[240px]',
        p.dimmed ? 'opacity-40' : 'opacity-100',
        p.highlighted ? 'ring-2 ring-[var(--color-accent)]' : '',
        'border-[var(--color-border)] hover:border-[var(--color-border-strong)]',
      ].join(' ')}
      data-testid={`org-chart-v2-card-${p.node.id}`}
      data-org-node-id={p.node.id}
      data-node-type={p.node.type}
      data-node-lob={p.node.lob ?? ''}
    >
      {/* ── header row: avatar · (name + role + first-resp + skills) · LOB pill · menu ── */}
      <div class="flex items-start gap-2 px-2.5 pt-2.5 pb-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); p.onAvatar(); }}
          class="shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center hover:opacity-90 transition-opacity"
          aria-label={`Open ${p.node.name} profile`}
        >
          <AgentAvatar agentId={p.node.id} name={p.node.name} size={32} running={p.node.running ?? undefined} src={p.node.avatar || undefined} />
        </button>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); p.onTitle(); }}
              class="flex-1 min-w-0 min-h-[44px] inline-flex items-center text-[13px] font-semibold leading-tight text-[var(--color-text)] hover:text-[var(--color-accent)] transition-colors text-left truncate"
              data-testid={`org-chart-v2-title-${p.node.id}`}
              title={p.node.name}
            >
              <span class="truncate">{p.node.name}</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); p.onTypeBadge(); }}
              data-testid={`org-chart-v2-badge-${p.node.id}`}
              aria-label={`Filter to ${p.node.type}`}
              title={`Filter to ${isHuman ? 'humans' : 'AI'}`}
              class="shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded hover:bg-[var(--color-elevated)] transition-colors"
            >
              {isHuman
                ? <User size={11} class="text-[var(--color-text-faint)]" />
                : <Bot size={11} class="text-[var(--color-accent)]" />}
            </button>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); p.onSubtitle(); }}
            class="block w-full min-h-[44px] text-[11px] leading-snug text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-left truncate"
            data-testid={`org-chart-v2-subtitle-${p.node.id}`}
            title={p.node.role || 'no role set'}
          >
            {p.node.role || 'no role set'}
          </button>

          {/* Slice 10 Wave 4 — first responsibility preview line. Hidden
              when the responsibilities array is empty so the card stays
              compact. Truncated visually; full text in the drawer. */}
          {firstResp && (
            <div
              class="mt-0.5 text-[10px] leading-snug text-[var(--color-text-faint)] truncate"
              data-testid={`org-chart-v2-resp-${p.node.id}`}
              title={firstResp}
            >
              {firstResp}
            </div>
          )}

          {/* skill chips — max 3 visible, no overflow chip on collapsed
              card per Wave 4 spec. The drawer lists every skill. */}
          {visibleSkills.length > 0 && (
            <div
              class="mt-1 flex flex-wrap gap-0.5"
              data-testid={`org-chart-v2-skills-${p.node.id}`}
            >
              {visibleSkills.map((s) => (
                <span
                  key={s}
                  class="inline-flex items-center px-1 py-px text-[9px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                  title={s}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* LOB pill on top-right (replaces the verbose "lob: agency"
            wording from Wave 2). Same colour as the rest of the chip
            row but slightly accented to signal LOB membership. */}
        {p.node.lob && (
          <span
            class="shrink-0 inline-flex items-center px-1.5 py-px text-[9px] rounded uppercase tracking-wider bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            data-testid={`org-chart-v2-lob-${p.node.id}`}
            title={`LOB: ${p.node.lob}`}
          >
            {p.node.lob}
          </span>
        )}

        <div class="relative shrink-0 -mr-1 -mt-1" ref={menuRef}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
            class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
            aria-label="Card actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid={`org-chart-v2-menu-${p.node.id}`}
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              class="absolute right-0 mt-1 z-30 w-44 rounded border border-[var(--color-border)] bg-[var(--color-card)] shadow-lg text-[12px] py-1"
            >
              <MenuItem
                label="Open"
                onClick={() => { setMenuOpen(false); p.onSubtitle(); }}
              />
              <MenuItem
                label="Focus mode"
                onClick={() => { setMenuOpen(false); p.onMenu.focus(p.node.id); }}
              />
              <MenuItem
                label="Expand all under"
                onClick={() => { setMenuOpen(false); p.onMenu.expandAllUnder(p.node.id); }}
              />
              <MenuItem
                label="Collapse siblings"
                onClick={() => { setMenuOpen(false); p.onMenu.collapseSiblings(p.node.id); }}
              />
              <MenuItem
                label="Copy link"
                onClick={() => { setMenuOpen(false); p.onMenu.copyLink(p.node.id); }}
              />
              <MenuItem
                label="Edit YAML…"
                onClick={() => {
                  setMenuOpen(false);
                  p.onMenu.editYaml(p.node.id);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── footer: counts + cadence — interactive buttons are 44×44
          to satisfy the Wave 1 touch-target contract; the visible
          dot+number is tight inside the larger hit-area. ── */}
      <div class="border-t border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-faint)] flex items-center justify-between flex-wrap gap-x-1">
        <div class="flex items-center">
          {p.hasChildren && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); p.onToggle(); }}
              class="cursor-pointer min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-0.5 hover:text-[var(--color-accent)] transition-colors"
              data-testid={`org-chart-v2-toggle-${p.node.id}`}
              aria-expanded={p.isOpen}
              aria-label={p.isOpen ? 'Collapse children' : 'Expand children'}
            >
              {p.isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <span class="font-medium">{reportCount}</span>
            </button>
          )}
          {humanReportCount > 0 && (
            <span
              class="inline-flex items-center justify-center gap-0.5 min-h-[44px] min-w-[28px] px-1"
              data-testid={`org-chart-v2-reports-${p.node.id}`}
              aria-label={`${humanReportCount} human report${humanReportCount === 1 ? '' : 's'}`}
              title={`${humanReportCount} human report${humanReportCount === 1 ? '' : 's'}`}
            >
              <User size={9} />
              <span>{humanReportCount}</span>
            </span>
          )}
          {aiReportCount > 0 && (
            <span
              class="inline-flex items-center justify-center gap-0.5 min-h-[44px] min-w-[28px] px-1"
              data-testid={`org-chart-v2-ai-reports-${p.node.id}`}
              aria-label={`${aiReportCount} AI employee${aiReportCount === 1 ? '' : 's'}`}
              title={`${aiReportCount} AI employee${aiReportCount === 1 ? '' : 's'}`}
            >
              <Bot size={9} />
              <span>{aiReportCount}</span>
            </span>
          )}
        </div>
        <div class="flex items-center">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); p.onScheduled(); }}
            class="cursor-pointer min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-0.5 hover:text-[var(--color-accent)] transition-colors"
            data-testid={`org-chart-v2-scheduled-${p.node.id}`}
            aria-label={`Open ${scheduled} scheduled task${scheduled === 1 ? '' : 's'}`}
            title={`${scheduled} scheduled task${scheduled === 1 ? '' : 's'}`}
          >
            <Calendar size={9} />
            <span>{scheduled}</span>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); p.onTriggered(); }}
            class="cursor-pointer min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-0.5 hover:text-[var(--color-accent)] transition-colors"
            data-testid={`org-chart-v2-triggered-${p.node.id}`}
            aria-label={`Open ${triggered} triggered task${triggered === 1 ? '' : 's'}`}
            title={`${triggered} triggered task${triggered === 1 ? '' : 's'}`}
          >
            <Zap size={9} />
            <span>{triggered}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      class="w-full text-left flex items-center min-h-[44px] min-w-[44px] px-3 py-2 hover:bg-[var(--color-elevated)] text-[var(--color-text)]"
    >
      {label}
    </button>
  );
}

// ── drawer body ──────────────────────────────────────────────────────

interface DrawerProps {
  node: TreeNode;
  byId: Map<string, TreeNode>;
  onJumpTo: (id: string) => void;
  onSkill: (slug: string) => void;
  onScheduled: (slug: string) => void;
  onTriggered: (slug: string) => void;
  onLob: (lob: string) => void;
  onProject: (project: string) => void;
  onYamlEdit: () => void;
}

function NodeDrawer(p: DrawerProps) {
  const n = p.node;
  const parent = n.reports_to ? p.byId.get(n.reports_to) ?? null : null;
  const isHuman = n.type === 'human';

  return (
    <div class="px-6 py-4 space-y-5">
      <div class="flex items-start gap-3">
        <AgentAvatar agentId={n.id} name={n.name} size={48} running={n.running ?? undefined} src={n.avatar || undefined} />
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-[15px] font-semibold text-[var(--color-text)] truncate">{n.name}</h3>
            <Pill tone={isHuman ? 'neutral' : 'accent'}>
              <span class="inline-flex items-center gap-1">
                {isHuman ? <User size={9} /> : <Bot size={9} />}
                {isHuman ? 'Human' : 'AI'}
              </span>
            </Pill>
          </div>
          <div class="text-[12px] text-[var(--color-text-muted)] mt-0.5">{n.role || 'no role set'}</div>
          {parent && (
            <div class="mt-1 text-[11px] text-[var(--color-text-faint)] flex items-center gap-1 flex-wrap">
              Reports to{' '}
              <button
                type="button"
                class="min-h-[44px] min-w-[44px] inline-flex items-center px-3 py-2 text-[var(--color-accent)] hover:underline"
                onClick={() => p.onJumpTo(parent.id)}
              >
                {parent.name}
              </button>
            </div>
          )}
        </div>
      </div>

      <DrawerSection title="Four Rs" onHeader={p.onYamlEdit}>
        <FourRsBlock four={n.four_rs} />
      </DrawerSection>

      <DrawerSection title="Personality">
        <PersonalityBlock pers={n.personality} />
      </DrawerSection>

      <DrawerSection title="Skills">
        {n.skills.primary.length === 0 ? (
          <p class="text-[12px] text-[var(--color-text-muted)]">None highlighted.</p>
        ) : (
          <div class="flex flex-wrap gap-1.5">
            {n.skills.primary.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => p.onSkill(s)}
                class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </DrawerSection>

      <DrawerSection title="Owns">
        <OwnsBlock
          owns={n.owns}
          onScheduled={p.onScheduled}
          onTriggered={p.onTriggered}
        />
      </DrawerSection>

      {/*
        n8n workflows live inside Owns per spec; the standalone section
        below has been removed in favor of OwnsBlock rendering all three
        sub-lists (scheduled, triggered, n8n) under a single OWNS header.
      */}

      <DrawerSection title="LOB / Projects">
        <div class="space-y-2 text-[12px]">
          {n.lob && (
            <div class="flex items-center gap-2">
              <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">LOB</span>
              <button
                type="button"
                onClick={() => p.onLob(n.lob!)}
                class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] transition-colors"
              >
                {n.lob}
              </button>
            </div>
          )}
          {n.projects.length > 0 && (
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Projects</span>
              {n.projects.map((pr) => (
                <button
                  key={pr}
                  type="button"
                  onClick={() => p.onProject(pr)}
                  class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] transition-colors"
                >
                  {pr}
                </button>
              ))}
            </div>
          )}
          {!n.lob && n.projects.length === 0 && (
            <p class="text-[12px] text-[var(--color-text-muted)]">No LOB or projects assigned.</p>
          )}
        </div>
      </DrawerSection>

      {n.children.length > 0 && (
        <DrawerSection title={`${n.children.length} report${n.children.length === 1 ? '' : 's'}`}>
          <ul class="space-y-1">
            {n.children.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => p.onJumpTo(c.id)}
                  class="w-full text-left flex items-center gap-2 px-3 py-2 min-h-[44px] min-w-[44px] rounded hover:bg-[var(--color-elevated)] transition-colors"
                  data-testid={`org-chart-v2-drawer-child-${c.id}`}
                >
                  <AgentAvatar agentId={c.id} name={c.name} size={24} />
                  <div class="flex-1 min-w-0">
                    <div class="text-[12px] text-[var(--color-text)] truncate">{c.name}</div>
                    <div class="text-[11px] text-[var(--color-text-muted)] truncate">{c.role}</div>
                  </div>
                  <Pill tone={c.type === 'human' ? 'neutral' : 'accent'}>{c.type === 'human' ? 'Human' : 'AI'}</Pill>
                </button>
              </li>
            ))}
          </ul>
        </DrawerSection>
      )}

    </div>
  );
}

function DrawerSection({
  title, children, onHeader,
}: {
  title: string;
  children: any;
  onHeader?: () => void;
}) {
  return (
    <div>
      {onHeader ? (
        <button
          type="button"
          onClick={onHeader}
          class="min-h-[44px] min-w-[44px] inline-flex items-center px-3 py-2 -mx-3 text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] mb-2 cursor-pointer"
        >
          {title}
        </button>
      ) : (
        <div class="text-[11px] uppercase tracking-wider text-[var(--color-text-faint)] mb-2">{title}</div>
      )}
      {children}
    </div>
  );
}

function FourRsBlock({ four }: { four: FourRs }) {
  const empty =
    !four.role &&
    four.responsibilities.length === 0 &&
    four.results.length === 0 &&
    four.requirements.length === 0;
  if (empty) {
    return <p class="text-[12px] text-[var(--color-text-muted)]">No Four Rs captured yet.</p>;
  }
  return (
    <div class="space-y-2 text-[12px]">
      {four.role && (
        <div>
          <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mr-1.5">Role</span>
          <span class="text-[var(--color-text)]">{four.role}</span>
        </div>
      )}
      {four.responsibilities.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Responsibilities</div>
          <ul class="list-disc pl-5 space-y-0.5 text-[var(--color-text)]">
            {four.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {four.results.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Results</div>
          <ul class="list-disc pl-5 space-y-0.5 text-[var(--color-text)]">
            {four.results.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {four.requirements.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Requirements</div>
          <ul class="list-disc pl-5 space-y-0.5 text-[var(--color-text)]">
            {four.requirements.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function PersonalityBlock({ pers }: { pers: Personality }) {
  const empty = !pers.tone && !pers.pushback && !pers.format;
  if (empty) {
    return <p class="text-[12px] text-[var(--color-text-muted)]">No personality captured yet.</p>;
  }
  return (
    <div class="text-[12px] space-y-1">
      {pers.tone && (
        <div>
          <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mr-1.5">Tone</span>
          <span class="text-[var(--color-text)]">{pers.tone}</span>
        </div>
      )}
      {pers.pushback && (
        <div>
          <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mr-1.5">Pushback</span>
          <span class="text-[var(--color-text)]">{pers.pushback}</span>
        </div>
      )}
      {pers.format && (
        <div>
          <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mr-1.5">Format</span>
          <span class="text-[var(--color-text)]">{pers.format}</span>
        </div>
      )}
    </div>
  );
}

function OwnsBlock({
  owns, onScheduled, onTriggered,
}: {
  owns: Owns;
  onScheduled: (slug: string) => void;
  onTriggered: (slug: string) => void;
}) {
  const empty =
    owns.scheduled_tasks.length === 0 &&
    owns.triggered_tasks.length === 0 &&
    owns.n8n_workflows.length === 0 &&
    owns.watchers.length === 0;
  if (empty) {
    return <p class="text-[12px] text-[var(--color-text-muted)]">No ownership pointers set.</p>;
  }
  return (
    <div class="space-y-2 text-[12px]">
      {owns.scheduled_tasks.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">
            Scheduled tasks ({owns.scheduled_tasks.length})
          </div>
          <div class="flex flex-wrap gap-1.5">
            {owns.scheduled_tasks.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onScheduled(t)}
                class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      {owns.triggered_tasks.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">
            Triggered tasks ({owns.triggered_tasks.length})
          </div>
          <div class="flex flex-wrap gap-1.5">
            {owns.triggered_tasks.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTriggered(t)}
                class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      {owns.n8n_workflows.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">
            n8n workflows ({owns.n8n_workflows.length})
          </div>
          <ul class="space-y-1">
            {owns.n8n_workflows.map((wf) => (
              <li key={wf}>
                <a
                  href={`https://n8n.joetroyer.com/workflow/${encodeURIComponent(wf)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center min-h-[44px] min-w-[44px] px-3 py-2 text-[var(--color-accent)] hover:underline"
                >
                  {wf}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {owns.watchers.length > 0 && (
        <div>
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">
            Watchers ({owns.watchers.length})
          </div>
          <div class="flex flex-wrap gap-1.5">
            {owns.watchers.map((w) => (
              <span
                key={w}
                class="px-2 py-0.5 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)]"
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ── YAML editor panel (Slice 10 Wave 3) ───────────────────────────────
//
// Inline editor that replaces the drawer body when the user clicks
// "Edit YAML" in the FOUR Rs section header (or the per-card menu's
// "Edit YAML…" item). Fetches the agent or human's full YAML text via
// /api/(agents|humans)/:id/yaml, exposes it in a plain <textarea>
// (no Monaco — too heavy, and we want this to ship without new deps),
// runs js-yaml.load() on every keystroke for a live valid/invalid
// indicator, and PUTs the raw text on Save. On 200 the parent calls
// refresh() on the org-chart fetch and closes the drawer; on error
// the panel surfaces the message inline and keeps the user in edit
// mode so the draft isn't lost.
//
// Path-safety lives on the server — this component happily sends any
// id the parent gave it, and the dashboard handler validates the id
// shape and resolves the file path itself.

interface YamlEditorPanelProps {
  node: TreeNode;
  onCancel: () => void;
  onSaved: () => void;
}

function YamlEditorPanel(p: YamlEditorPanelProps) {
  const isHuman = p.node.type === 'human';
  const endpoint = isHuman
    ? `/api/humans/${encodeURIComponent(p.node.id)}/yaml`
    : `/api/agents/${encodeURIComponent(p.node.id)}/yaml`;

  // 'idle' on first paint while we fetch the current yaml. Once loaded
  // we stay in 'editing'. 'saving' disables the buttons so a double-
  // click can't race two PUTs.
  const [phase, setPhase] = useState<'loading' | 'editing' | 'saving'>('loading');
  const [text, setText] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Cold load. Aborts cleanly if the user cancels before the GET resolves.
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setLoadError(null);
    apiGet<{ yaml: string }>(endpoint)
      .then((d) => {
        if (cancelled) return;
        setText(d.yaml ?? '');
        setPhase('editing');
        // Microtask so the textarea is mounted before we focus it —
        // otherwise the drawer's focus trap steals focus on the next
        // tick and the cursor never lands here.
        requestAnimationFrame(() => textareaRef.current?.focus());
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : String(err);
        setLoadError(msg);
        setPhase('editing'); // surface a recoverable empty editor
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  // Parse-on-type for the live valid/invalid badge. Cheap — js-yaml
  // tops out around a few thousand documents/second on a 64KB cap.
  useEffect(() => {
    if (phase === 'loading') return;
    try {
      const parsed = jsyaml.load(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setParseError('Top-level must be a YAML object');
        return;
      }
      setParseError(null);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, [text, phase]);

  async function handleSave() {
    if (parseError) return;
    setPhase('saving');
    setSaveError(null);
    try {
      await apiPut<{ ok: boolean }>(endpoint, { yaml: text });
      pushToast({ tone: 'success', title: 'YAML saved' });
      p.onSaved();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setSaveError(msg);
      setPhase('editing');
      pushToast({ tone: 'error', title: 'Save failed', description: msg });
    }
  }

  const canSave = phase === 'editing' && !parseError && !loadError;

  return (
    <div class="px-6 py-4 space-y-3" data-testid="org-chart-v2-yaml-editor">
      <div class="flex items-start gap-3">
        <AgentAvatar agentId={p.node.id} name={p.node.name} size={36} />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-[14px] font-semibold text-[var(--color-text)] truncate">
              Edit YAML — {p.node.name}
            </h3>
            <Pill tone={isHuman ? 'neutral' : 'accent'}>
              {isHuman ? 'humans.yaml' : 'agent.yaml'}
            </Pill>
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)] mt-0.5">
            {isHuman
              ? 'Edits this human\'s block in humans.yaml.'
              : `Edits agents/${p.node.id}/agent.yaml. Takes effect on next agent restart.`}
          </div>
        </div>
      </div>

      {loadError && (
        <div
          class="rounded border border-[var(--color-danger,#b94a48)] bg-[var(--color-danger-soft,rgba(185,74,72,0.12))] px-3 py-2 text-[12px] text-[var(--color-danger,#b94a48)]"
          data-testid="org-chart-v2-yaml-load-error"
        >
          Could not load yaml: {loadError}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        spellcheck={false}
        rows={20}
        disabled={phase === 'loading' || phase === 'saving'}
        class="w-full px-3 py-2 rounded bg-[var(--color-elevated)] border border-[var(--color-border)] text-[12px] font-mono text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        placeholder={phase === 'loading' ? 'Loading…' : ''}
        data-testid="org-chart-v2-yaml-textarea"
      />

      <div
        class="flex items-center justify-between gap-2 text-[11px]"
        data-testid="org-chart-v2-yaml-status"
      >
        <div class="min-w-0 flex-1">
          {phase === 'loading' ? (
            <span class="text-[var(--color-text-muted)]">Loading…</span>
          ) : parseError ? (
            <span
              class="text-[var(--color-danger,#b94a48)] truncate inline-block max-w-full"
              data-testid="org-chart-v2-yaml-parse-error"
              title={parseError}
            >
              Invalid: {parseError}
            </span>
          ) : (
            <span
              class="text-[var(--color-success,#3aa863)]"
              data-testid="org-chart-v2-yaml-parse-ok"
            >
              YAML valid
            </span>
          )}
        </div>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            onClick={p.onCancel}
            disabled={phase === 'saving'}
            class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-card)] transition-colors disabled:opacity-50"
            data-testid="org-chart-v2-yaml-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 text-[11px] rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="org-chart-v2-yaml-save"
          >
            {phase === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && (
        <div
          class="rounded border border-[var(--color-danger,#b94a48)] bg-[var(--color-danger-soft,rgba(185,74,72,0.12))] px-3 py-2 text-[12px] text-[var(--color-danger,#b94a48)]"
          data-testid="org-chart-v2-yaml-save-error"
        >
          {saveError}
        </div>
      )}
    </div>
  );
}
