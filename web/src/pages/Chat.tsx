import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Send, Square, Sparkles, ArrowDown, Mic } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { StatusDot } from '@/components/Pill';
import { SkillPicker } from '@/components/SkillPicker';
import { useFetch } from '@/lib/useFetch';
import { apiGet, apiPost, apiUpload, chatId } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { formatCost, formatNumber } from '@/lib/format';
import { showCosts } from '@/lib/theme';
import { subscribeChatStream, chatStreamConnected, resetUnread } from '@/lib/chat-stream';
import { pushToast } from '@/lib/toasts';

interface Turn { role: 'user' | 'assistant'; content: string; source?: string; created_at?: number; photoUrl?: string; photoCaption?: string; }
interface Agent { id: string; name: string; running: boolean; }

interface AgentTokens { todayCost: number; todayTurns: number; allTimeCost: number; }
interface Health { contextPct: number; turns: number; model: string; }

const QUICK_ACTIONS = [
  { label: 'Status update', prompt: "Quick status update: what are you working on right now?" },
  { label: "What's next", prompt: 'What should I focus on next based on context?' },
  { label: 'Plan today', prompt: 'What does my day look like today? What are the priorities?' },
  { label: 'Recent wins', prompt: 'What did I accomplish in the last 24 hours?' },
];

export function Chat() {
  const [location, navigate] = useLocation();
  const agents = useFetch<{ agents: Agent[] }>('/api/agents', 60_000);
  // Read ?agent=<id> on mount (and when the URL changes via in-app links)
  // so deep links from other pages preselect the right agent thread. The
  // query param is stripped after consumption to keep the URL tidy and
  // prevent it from clobbering manual tab switches on later renders.
  const [activeAgent, setActiveAgent] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all';
    const param = new URL(window.location.href).searchParams.get('agent');
    return param ? param : 'all';
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const param = url.searchParams.get('agent');
    if (!param) return;
    setActiveAgent(param);
    url.searchParams.delete('agent');
    navigate(url.pathname + (url.search ? url.search : ''));
  }, [location]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamConnected = chatStreamConnected.value;
  // SkillPicker state. The picker mounts persistently so its catalog
  // stays cached across opens; we just toggle `pickerOpen`.
  const [pickerOpen, setPickerOpen] = useState(false);
  // When the picker opens via "/-typing", we seed it with whatever the
  // user has already typed after the slash so they don't have to retype.
  const [pickerInitialQuery, setPickerInitialQuery] = useState('');

  // Voice note → STT state. Click-toggle: idle → recording → transcribing
  // → idle. We hold the active recorder + media stream in refs so the
  // stop handler can finalize the blob and clean up tracks even after
  // the component re-renders during recording.
  const [recState, setRecState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const [micSupported] = useState<boolean>(() =>
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof MediaRecorder !== 'undefined',
  );
  const [micDenied, setMicDenied] = useState(false);
  // Track whether the message list is scrolled near the bottom. Drives
  // the floating "scroll to latest" button and tells the auto-scroll
  // effect whether it's safe to jump on a new turn (we don't yank the
  // viewport while the user is reading older messages).
  const [atBottom, setAtBottom] = useState(true);

  function scrollToBottom(smooth = true) {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // Live session info for the bar.
  const health = useFetch<Health>(`/api/health?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const agentTokens = useFetch<AgentTokens>(
    activeAgent === 'all' ? null : `/api/agents/${activeAgent}/tokens`,
    30_000,
  );

  // Load conversation history when active agent changes.
  useEffect(() => {
    setLoading(true);
    const path = activeAgent === 'all'
      ? `/api/chat/history?chatId=${encodeURIComponent(chatId)}&limit=50`
      : `/api/agents/${activeAgent}/conversation?chatId=${encodeURIComponent(chatId)}&limit=50`;
    apiGet<{ turns: Turn[] }>(path)
      .then((d) => setTurns(d.turns || []))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [activeAgent]);

  // Auto-scroll only when the user is already near the bottom. New
  // messages arriving while they're reading history shouldn't yank
  // them away.
  useEffect(() => {
    if (atBottom && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [turns, processing, atBottom]);

  // Watch the message list scroll position so the "scroll to latest"
  // button shows up the moment the user scrolls away from the bottom.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    function onScroll() {
      const dist = el!.scrollHeight - el!.scrollTop - el!.clientHeight;
      setAtBottom(dist < 60);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [activeAgent]);

  // Subscribe to the global chat SSE (started in main.tsx). The page just
  // reads the events; the stream itself stays open for the whole app
  // lifecycle so the sidebar unread badge keeps tracking.
  useEffect(() => {
    resetUnread();
    const unsub = subscribeChatStream((eventName, data) => {
      if (eventName === 'user_message') {
        setTurns((prev) => [...prev, { role: 'user', content: data.content, source: data.source }]);
      } else if (eventName === 'assistant_message') {
        setTurns((prev) => [...prev, { role: 'assistant', content: data.content, source: data.source }]);
        setProcessing(false); setProgressLabel(null);
        health.refresh();
        if (activeAgent !== 'all') agentTokens.refresh();
      } else if (eventName === 'assistant_photo') {
        // Inline photo bubble. The bot already stripped the marker from
        // the text-side assistant_message; this event carries the URL.
        setTurns((prev) => [...prev, {
          role: 'assistant',
          content: '',
          source: data.source,
          photoUrl: data.url,
          photoCaption: data.caption,
        }]);
      } else if (eventName === 'processing') {
        if (data.processing !== undefined) setProcessing(!!data.processing);
        if (!data.processing) setProgressLabel(null);
      } else if (eventName === 'progress') {
        if (data.description) setProgressLabel(data.description);
      } else if (eventName === 'error') {
        setTurns((prev) => [...prev, { role: 'assistant', content: data.content || 'Error' }]);
        setProcessing(false); setProgressLabel(null);
      }
    });
    return unsub;
  }, [activeAgent]);

  async function send(textOverride?: string) {
    const message = (textOverride ?? draft).trim();
    if (!message) return;
    setSending(true); setError(null);
    try {
      const res = await apiPost<{ ok?: boolean; error?: string }>('/api/chat/send', { message });
      if (!res.ok && res.error) {
        setError(res.error === 'busy' ? 'A turn is already in flight. Wait for it to finish.' : res.error);
      } else if (!textOverride) {
        setDraft('');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally { setSending(false); }
  }

  async function abort() {
    try { await apiPost('/api/chat/abort'); } catch {}
  }

  function quick(prompt: string) {
    void send(prompt);
    inputRef.current?.focus();
  }

  // Insert "/<id> " at the current caret. If the textarea already starts
  // with "/<token>" (the user typed a slash to open the picker), replace
  // that prefix instead of stacking another slash.
  function insertSkill(slug: string) {
    const ta = inputRef.current;
    if (!ta) return;
    const value = draft;
    const insertText = '/' + slug + ' ';
    let nextValue: string;
    let nextCaret: number;
    const startsWithSlashToken = /^\/[a-zA-Z0-9_-]*$/.test(value.trim()) && value.trim() === value.trimStart();
    if (startsWithSlashToken) {
      // Replace the entire leading slash-token. Preserves anything after
      // it (which there shouldn't be given the regex, but be safe).
      nextValue = insertText + value.slice(value.indexOf(value.trim()) + value.trim().length);
      nextCaret = insertText.length;
    } else {
      const caret = ta.selectionStart ?? value.length;
      nextValue = value.slice(0, caret) + insertText + value.slice(caret);
      nextCaret = caret + insertText.length;
    }
    setDraft(nextValue);
    setPickerOpen(false);
    // Restore focus + caret on next tick (after re-render).
    queueMicrotask(() => {
      const t = inputRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function onComposerKeyDown(e: KeyboardEvent) {
    // Open the picker when the user types "/" as the first character.
    // We catch this on keydown so the slash never lands in the textarea
    // — opening the picker BEFORE the slash propagates makes the inline
    // and button-triggered flows feel identical.
    if (e.key === '/' && draft.length === 0 && !pickerOpen) {
      e.preventDefault();
      setPickerInitialQuery('');
      setPickerOpen(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // If picker is open, Enter is the picker's job.
      if (pickerOpen) return;
      e.preventDefault();
      if (draft.trim()) void send();
    }
  }

  // Pick a mimeType MediaRecorder will actually accept. Chromium and
  // Firefox both speak Opus-in-WebM; Safari needs MP4. If neither is
  // available, pass undefined and let the browser pick its default.
  function pickMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined') return undefined;
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const c of candidates) {
      try {
        if ((MediaRecorder as any).isTypeSupported && (MediaRecorder as any).isTypeSupported(c)) {
          return c;
        }
      } catch { /* ignore */ }
    }
    return undefined;
  }

  // Stop tracks + clear refs. Idempotent so we can call it from anywhere
  // without worrying about double-cleanup.
  function teardownRecording() {
    try { recorderRef.current?.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { recStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    recorderRef.current = null;
    recStreamRef.current = null;
    recChunksRef.current = [];
  }

  // Insert the transcript at the textarea cursor (or end if no caret).
  // Keeps focus + moves the caret to the end of the inserted text.
  function appendTranscript(text: string) {
    const ta = inputRef.current;
    if (!ta) {
      setDraft((prev) => (prev ? prev + ' ' : '') + text);
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    // Insert with a single space if we're appending into an existing
    // non-empty word; otherwise paste verbatim.
    const needsSpace = before && !/\s$/.test(before) ? ' ' : '';
    const inserted = needsSpace + text;
    const next = before + inserted + after;
    setDraft(next);
    // After Preact applies the new value, restore focus + caret.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const caret = before.length + inserted.length;
      try { el.setSelectionRange(caret, caret); } catch { /* ignore */ }
    });
  }

  async function startRecording() {
    if (!micSupported) return;
    if (micDenied) {
      pushToast({
        tone: 'warn',
        title: 'Mic permission denied',
        description: 'Enable in browser settings, then refresh.',
      });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      if (denied) setMicDenied(true);
      pushToast({
        tone: 'warn',
        title: denied ? 'Mic permission denied' : 'Mic unavailable',
        description: denied ? 'Enable in browser settings, then refresh.' : (err?.message || ''),
      });
      return;
    }
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err: any) {
      stream.getTracks().forEach((t) => t.stop());
      pushToast({ tone: 'error', title: 'Recorder failed to start', description: err?.message || '' });
      return;
    }
    recChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const chunks = recChunksRef.current;
      const blobType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: blobType });
      teardownRecording();
      void uploadAndTranscribe(blob);
    };
    recorderRef.current = recorder;
    recStreamRef.current = stream;
    recorder.start();
    setRecState('recording');
  }

  function stopRecording() {
    const r = recorderRef.current;
    if (!r) {
      setRecState('idle');
      teardownRecording();
      return;
    }
    setRecState('transcribing');
    try {
      r.stop();
    } catch {
      teardownRecording();
      setRecState('idle');
    }
  }

  async function uploadAndTranscribe(blob: Blob) {
    if (!blob || blob.size === 0) {
      setRecState('idle');
      pushToast({ tone: 'warn', title: 'No audio captured' });
      return;
    }
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('webm') ? 'webm' : 'audio';
    const form = new FormData();
    form.append('file', blob, `voice-note.${ext}`);
    try {
      const res = await apiUpload<{ text: string }>('/api/transcribe', form);
      const text = (res.text || '').trim();
      if (text) appendTranscript(text);
      else pushToast({ tone: 'warn', title: 'No speech detected' });
    } catch (err: any) {
      pushToast({
        tone: 'error',
        title: 'Transcription failed',
        description: err?.message || String(err),
      });
    } finally {
      setRecState('idle');
    }
  }

  function toggleMic() {
    if (recState === 'idle') void startRecording();
    else if (recState === 'recording') stopRecording();
    // 'transcribing' is a no-op — the request is in flight.
  }

  // Cleanup on unmount: kill any active mic stream so we don't leave
  // the tab's recording indicator on after the user navigates away.
  useEffect(() => {
    return () => { teardownRecording(); };
  }, []);

  const agentList = agents.data?.agents ?? [];
  const activeAgentObj = agentList.find((a) => a.id === activeAgent);
  const todayCost = activeAgent === 'all'
    ? agentList.reduce((sum, a: any) => sum + (a.todayCost || 0), 0)
    : agentTokens.data?.todayCost ?? 0;
  const todayTurns = activeAgent === 'all'
    ? agentList.reduce((sum, a: any) => sum + (a.todayTurns || 0), 0)
    : agentTokens.data?.todayTurns ?? 0;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Chat"
        actions={
          <span class="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <StatusDot tone={streamConnected ? 'done' : 'cancelled'} />
            {streamConnected ? 'Stream live' : 'Reconnecting…'}
          </span>
        }
        tabs={
          <>
            <TabBtn label="All" active={activeAgent === 'all'} onClick={() => setActiveAgent('all')} />
            {agentList.map((a) => (
              <TabBtn key={a.id} label={a.name || a.id} active={activeAgent === a.id} onClick={() => setActiveAgent(a.id)} live={a.running} />
            ))}
          </>
        }
      />

      <SessionBar
        contextPct={health.data?.contextPct}
        turnsToday={todayTurns}
        costToday={todayCost}
        model={activeAgent === 'all' ? health.data?.model : undefined}
        agentLabel={activeAgentObj ? activeAgentObj.name || activeAgentObj.id : undefined}
      />

      <div class="relative flex-1 min-h-0">
        <div ref={messagesRef} class="absolute inset-0 overflow-y-auto px-6 py-4 space-y-2">
          {error && <div class="text-[var(--color-status-failed)] text-[11.5px]">{error}</div>}
          {loading && <PageState loading />}
          {!loading && turns.length === 0 && (
            <PageState empty emptyTitle="No messages yet" emptyDescription="Type below to talk to your agent. Replies stream in via SSE." />
          )}
          {turns.map((t, i) => <Bubble key={i} turn={t} />)}
          {processing && <ProcessingBubble label={progressLabel} />}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            class="absolute bottom-3 right-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium bg-[var(--color-accent)] text-white shadow-lg hover:bg-[var(--color-accent-hover)] transition-colors"
            aria-label="Scroll to latest message"
          >
            <ArrowDown size={13} />
            Latest
          </button>
        )}
      </div>

      <div class="border-t border-[var(--color-border)] px-4 pt-2 pb-3">
        <div class="max-w-4xl mx-auto">
          <div class="flex items-center gap-1 mb-2 flex-wrap">
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.label}
                type="button"
                onClick={() => quick(qa.prompt)}
                disabled={processing || sending}
                class="px-2 py-0.5 rounded text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] border border-[var(--color-border)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {qa.label}
              </button>
            ))}
          </div>
          {/* Composer row. The wrapping div is `relative` so SkillPicker
              can anchor its popover to it (bottom-full + left-0). */}
          <div class="relative flex items-end gap-2">
            <SkillPicker
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onPick={(s) => insertSkill(s.id)}
              initialQuery={pickerInitialQuery}
            />
            <textarea
              ref={inputRef}
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Type a message. Shift+Enter for newline. Try / for commands."
              rows={1}
              class="flex-1 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)] resize-none max-h-32"
            />
            <button
              type="button"
              onClick={() => { setPickerInitialQuery(''); setPickerOpen((v) => !v); }}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              title="Show slash commands"
              class={[
                'inline-flex items-center justify-center gap-1 px-2.5 min-h-[44px] min-w-[44px] rounded-lg text-[11.5px] font-medium border transition-colors shrink-0',
                pickerOpen
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)] border-[var(--color-accent)]/40'
                  : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
              ].join(' ')}
            >
              <span class="font-mono">/</span> Commands
            </button>
            {micSupported && (
              <button
                type="button"
                onClick={toggleMic}
                disabled={recState === 'transcribing' || sending}
                aria-label={
                  recState === 'recording' ? 'Stop recording' :
                  recState === 'transcribing' ? 'Transcribing' :
                  'Start voice note'
                }
                title={
                  recState === 'recording' ? 'Stop recording' :
                  recState === 'transcribing' ? 'Transcribing…' :
                  'Voice note'
                }
                class={[
                  'inline-flex items-center justify-center rounded-lg transition-colors',
                  // 44x44 touch target on mobile, slightly tighter on desktop
                  'min-w-[44px] min-h-[44px] sm:min-w-[40px] sm:min-h-[40px] px-2',
                  recState === 'recording'
                    ? 'bg-[var(--color-status-failed)] text-white ring-2 ring-[var(--color-status-failed)]/40 animate-pulse'
                    : recState === 'transcribing'
                      ? 'bg-[var(--color-elevated)] text-[var(--color-text-muted)] border border-[var(--color-border)]'
                      : 'bg-[var(--color-elevated)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-card)]',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                ].join(' ')}
              >
                {recState === 'transcribing' ? (
                  <Sparkles size={14} class="animate-pulse" />
                ) : (
                  <Mic size={14} fill={recState === 'recording' ? 'currentColor' : 'none'} />
                )}
              </button>
            )}
            {processing ? (
              <button
                type="button"
                onClick={abort}
                class="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[12px] font-medium bg-[var(--color-status-failed)] text-white hover:opacity-90 transition-opacity shrink-0"
              >
                <Square size={12} fill="currentColor" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
                class="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                <Send size={12} /> {sending ? 'Sending…' : 'Send'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionBar({
  contextPct, turnsToday, costToday, model, agentLabel,
}: {
  contextPct?: number; turnsToday: number; costToday: number; model?: string; agentLabel?: string;
}) {
  return (
    <div class="flex items-center gap-4 px-6 py-1.5 border-b border-[var(--color-border)] text-[10.5px] text-[var(--color-text-faint)] tabular-nums">
      {agentLabel && (
        <span><span class="uppercase tracking-wider">Agent</span> <span class="text-[var(--color-text-muted)] normal-case tracking-normal">{agentLabel}</span></span>
      )}
      {typeof contextPct === 'number' && (
        <span><span class="uppercase tracking-wider">Ctx</span> <span class="text-[var(--color-text-muted)]">{contextPct}%</span></span>
      )}
      <span><span class="uppercase tracking-wider">Turns today</span> <span class="text-[var(--color-text-muted)]">{formatNumber(turnsToday)}</span></span>
      {showCosts.value && (
        <span><span class="uppercase tracking-wider">Cost today</span> <span class="text-[var(--color-text-muted)]">{formatCost(costToday)}</span></span>
      )}
      {model && (
        <span class="ml-auto"><span class="uppercase tracking-wider">Model</span> <span class="text-[var(--color-text-muted)] normal-case font-mono">{model.replace('claude-', '')}</span></span>
      )}
    </div>
  );
}

function TabBtn({ label, active, onClick, live }: { label: string; active: boolean; onClick: () => void; live?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={[
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] transition-colors',
        active
          ? 'bg-[var(--color-elevated)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)]',
      ].join(' ')}
    >
      {live !== undefined && <StatusDot tone={live ? 'done' : 'cancelled'} />}
      {label}
    </button>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === 'user';
  const isPhoto = !!turn.photoUrl;
  const html = (isUser || isPhoto) ? null : renderMarkdown(turn.content);
  return (
    <div class={'flex ' + (isUser ? 'justify-end' : 'justify-start')}>
      <div
        class={[
          'max-w-[75%] rounded-lg text-[12.5px] leading-relaxed overflow-hidden',
          isPhoto ? 'p-1' : 'px-3 py-2',
          isUser
            ? 'bg-[var(--color-accent)] text-white rounded-br-sm whitespace-pre-wrap'
            : 'bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text)] rounded-bl-sm chat-md',
        ].join(' ')}
      >
        {isPhoto ? (
          <>
            <img
              src={turn.photoUrl}
              alt={turn.photoCaption || 'attached image'}
              class="block rounded max-h-[320px] w-auto object-contain"
              loading="lazy"
            />
            {turn.photoCaption && (
              <div class="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{turn.photoCaption}</div>
            )}
          </>
        ) : isUser ? (
          turn.content
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html || '' }} />
        )}
        {turn.source === 'dashboard' && !isPhoto && (
          <div class="text-[9.5px] opacity-60 mt-1 uppercase tracking-wider">via dashboard</div>
        )}
      </div>
    </div>
  );
}

function ProcessingBubble({ label }: { label: string | null }) {
  return (
    <div class="flex justify-start">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg rounded-bl-sm px-3 py-2 text-[12px] text-[var(--color-text-muted)] inline-flex items-center gap-2">
        <Sparkles size={12} class="animate-pulse text-[var(--color-accent)]" />
        {label || 'Thinking…'}
      </div>
    </div>
  );
}
