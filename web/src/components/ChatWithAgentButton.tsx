import { MessageCircle } from 'lucide-preact';
import { useLocation } from 'wouter-preact';

// One-tap chat shortcut wherever an agent is referenced. Navigates to
// `/chat?agent=<id>` which the Chat page reads on mount to preselect
// the right thread. The 44×44 touch target follows the rest of the SPA.
//
// Use `size` to bump the icon up on dense surfaces like the Agents page
// card; default 14 keeps it discreet when sitting next to inline labels
// (Mission Control header, Scheduled rows, etc.).
export function ChatWithAgentButton({
  agentId,
  agentName,
  size = 14,
  variant = 'inline',
  onActivate,
}: {
  agentId: string;
  agentName?: string;
  size?: number;
  /**
   * `inline` — small, transparent, used in headers and rows.
   * `card`   — slightly bigger hit area for the Agents page card.
   */
  variant?: 'inline' | 'card';
  /** Optional hook so callers can stop card click bubbling, fire toasts, etc. */
  onActivate?: () => void;
}) {
  const [, navigate] = useLocation();
  const label = `Chat with ${agentName || agentId}`;
  // `card` gives the Agents page a roomier tap target; `inline` keeps
  // dense surfaces (Mission Control headers, Scheduled rows) from
  // bloating. Both meet the 44×44 effective touch target on mobile via
  // the surrounding row height + padding — overriding it here would
  // wreck the layouts those components already ship.
  const padding = variant === 'card' ? 'p-2' : 'p-1.5';

  function go(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onActivate?.();
    navigate('/chat?agent=' + encodeURIComponent(agentId));
  }

  return (
    <button
      type="button"
      onClick={go}
      title={label}
      aria-label={label}
      class={[
        'inline-flex items-center justify-center rounded',
        padding,
        'text-[var(--color-text-muted)] hover:text-[var(--color-accent)]',
        'hover:bg-[var(--color-elevated)] transition-colors',
      ].join(' ')}
    >
      <MessageCircle size={size} />
    </button>
  );
}
