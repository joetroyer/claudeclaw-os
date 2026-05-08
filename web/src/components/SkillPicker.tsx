import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Search } from 'lucide-preact';
import { apiGet } from '@/lib/api';

// Shape of /api/skills response. The backend serves a stable {skills: [...]}
// envelope so the client can ignore additional fields the server may add.
interface ApiSkill {
  id: string;
  name: string;
  description: string;
  source: 'project' | 'global';
}

interface ApiSkillsResponse {
  skills: ApiSkill[];
}

// Module-level cache keeps the catalog warm across mount/unmount cycles —
// when the user toggles between pages the picker doesn't re-fetch unless
// it's been more than REFRESH_MS or the page has just regained focus.
let cachedSkills: ApiSkill[] | null = null;
let cachedAt = 0;
const REFRESH_MS = 60_000;

interface SkillPickerProps {
  open: boolean;
  onClose: () => void;
  // Called with the slug (e.g. "gmail"); the parent inserts "/<slug> "
  // into the composer at the current caret position.
  onPick: (skill: ApiSkill) => void;
  // Optional initial query — used by the "/-typed" trigger so the user's
  // already-entered slash token pre-filters the list.
  initialQuery?: string;
}

export function SkillPicker({ open, onClose, onPick, initialQuery = '' }: SkillPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const [skills, setSkills] = useState<ApiSkill[]>(cachedSkills ?? []);
  const [loading, setLoading] = useState(cachedSkills === null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch on open. Refetch if cache is stale or this is a fresh mount.
  useEffect(() => {
    if (!open) return;
    const stale = !cachedSkills || (Date.now() - cachedAt > REFRESH_MS);
    if (!stale) {
      setSkills(cachedSkills!);
      setLoading(false);
      return;
    }
    setLoading(cachedSkills === null);
    apiGet<ApiSkillsResponse>('/api/skills')
      .then((r) => {
        const arr = Array.isArray(r.skills) ? r.skills : [];
        // Sort: project first, then global; alphabetical within each group.
        arr.sort((a, b) => {
          if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
          return a.id.localeCompare(b.id);
        });
        cachedSkills = arr;
        cachedAt = Date.now();
        setSkills(arr);
        setError(null);
      })
      .catch((err: any) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  }, [open]);

  // Refetch on tab focus so a newly-added SKILL.md surfaces without a
  // hard reload. Cheap — the endpoint is a small JSON payload and the
  // backend now does live-reload on its own, so this is just a poke.
  useEffect(() => {
    if (!open) return;
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      apiGet<ApiSkillsResponse>('/api/skills')
        .then((r) => {
          const arr = Array.isArray(r.skills) ? r.skills : [];
          arr.sort((a, b) => {
            if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
            return a.id.localeCompare(b.id);
          });
          cachedSkills = arr;
          cachedAt = Date.now();
          setSkills(arr);
        })
        .catch(() => {/* keep stale cache */});
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [open]);

  // Reset state when the popup opens or initialQuery changes.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setActiveIndex(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open, initialQuery]);

  // Token-aware filter: every token must appear in name OR description.
  // Mirrors the war-room text filter so the UX feels consistent.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    const tokens = q.split(/\s+/).filter(Boolean);
    return skills.filter((s) => {
      const hay = (s.id + ' ' + s.name + ' ' + s.description).toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [query, skills]);

  // Keep activeIndex in range when filter shrinks the list.
  useEffect(() => {
    if (activeIndex >= visible.length && visible.length > 0) setActiveIndex(0);
  }, [visible.length]);

  // Scroll the active row into view when it changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector('[data-row-idx="' + activeIndex + '"]') as HTMLElement | null;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  // Close on outside click. The backdrop swallows clicks below the panel.
  if (!open) return null;

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const sel = visible[activeIndex];
      if (sel) onPick(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <>
      {/* Backdrop swallows clicks AND keeps the layout flex-column above
          the composer. Pointer-events:auto only on backdrop+panel — the
          rest of the page stays interactive when the picker is closed. */}
      <div
        class="fixed inset-0 z-[80]"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Anchored panel: bottom-left of the composer. We position it via
          absolute inside the composer area instead of fixed coords so it
          tracks the composer when the viewport resizes. The parent wraps
          the picker in a `relative` container — that's the anchor. */}
      <div
        class="absolute z-[81] bottom-full mb-2 left-0 w-[min(420px,92vw)] max-h-[360px] flex flex-col bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg shadow-2xl overflow-hidden"
        role="listbox"
        aria-label="Skills"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] shrink-0">
          <Search size={14} class="text-[var(--color-text-faint)]" />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search skills…"
            class="flex-1 bg-transparent outline-none text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]"
            value={query}
            onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setActiveIndex(0); }}
            onKeyDown={handleKey}
          />
          <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] tabular-nums">
            {visible.length}
          </span>
        </div>

        <div ref={listRef} class="flex-1 min-h-0 overflow-y-auto py-1">
          {loading && (
            <div class="px-3 py-4 text-[12px] text-[var(--color-text-faint)] text-center">Loading skills…</div>
          )}
          {!loading && error && (
            <div class="px-3 py-4 text-[12px] text-[var(--color-status-failed)] text-center">
              {error}
            </div>
          )}
          {!loading && !error && visible.length === 0 && (
            <div class="px-3 py-4 text-[12px] text-[var(--color-text-faint)] text-center">
              {query ? 'No skills match "' + query + '"' : 'No skills available'}
            </div>
          )}
          {!loading && !error && visible.map((s, i) => {
            const active = i === activeIndex;
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={active}
                data-row-idx={i}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); onPick(s); }}
                class={[
                  'w-full flex items-baseline gap-2 px-3 py-1.5 text-left transition-colors',
                  active
                    ? 'bg-[var(--color-accent-soft)]'
                    : 'hover:bg-[var(--color-elevated)]',
                ].join(' ')}
              >
                <span class="font-mono text-[12.5px] font-semibold text-[var(--color-text)] shrink-0">
                  /{s.id}
                </span>
                <SourcePill source={s.source} />
                <span class="text-[11.5px] text-[var(--color-text-muted)] truncate">
                  {s.description}
                </span>
              </button>
            );
          })}
        </div>

        <div class="flex items-center gap-3 px-3 py-1.5 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)] uppercase tracking-wider shrink-0">
          <span>↑↓ Navigate</span>
          <span>↵ Insert</span>
          <span>Esc Close</span>
        </div>
      </div>
    </>
  );
}

function SourcePill({ source }: { source: 'project' | 'global' }) {
  const isProj = source === 'project';
  return (
    <span
      class={[
        'inline-block px-1.5 py-0 rounded text-[8.5px] font-mono font-bold tracking-wider uppercase shrink-0 border',
        isProj
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-[var(--color-accent)]/40'
          : 'bg-transparent text-[var(--color-text-faint)] border-[var(--color-border)]',
      ].join(' ')}
    >
      {isProj ? 'PROJ' : 'GLOBAL'}
    </span>
  );
}
