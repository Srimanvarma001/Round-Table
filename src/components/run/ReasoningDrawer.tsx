'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Avatar } from '@/components/table/Avatar';
import { Button } from '@/components/ui/button';
import type { SeatLiveState } from '@/hooks/useRunStream';
import type { AvatarStyle } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';

/**
 * The reasoning drawer, section 16.6.
 *
 * A right-side sheet on desktop (480px) and a bottom sheet on mobile, with tabs
 * across the top for each seat so the user can flick between live reasoning
 * streams. Given `layoutScroll` on the content container so the shared layout
 * animation does not fight the internal scroll.
 *
 * Two stacked panes: the reasoning channel on top in `--text-mute` with a
 * subtle italic treatment and a slow typewriter reveal, and the answer channel
 * below in `--text`. When a model exposes no separate reasoning channel the
 * drawer collapses to a single pane and shows a one-line note, "this model does
 * not expose its reasoning", rather than leaving an empty pane with no
 * explanation.
 */

export interface ReasoningDrawerProps {
  agents: AgentDTO[];
  seats: Record<string, SeatLiveState>;
  openAgentId: string | null;
  onClose: () => void;
  /** Restores focus to the seat that opened the drawer (section 16.12). */
  onClosed: (agentId: string) => void;
}

export function ReasoningDrawer({
  agents,
  seats,
  openAgentId,
  onClose,
  onClosed,
}: ReasoningDrawerProps) {
  const [activeId, setActiveId] = useState<string | null>(openAgentId);
  const [autoFollow, setAutoFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const open = openAgentId != null;

  useEffect(() => {
    if (openAgentId) setActiveId(openAgentId);
  }, [openAgentId]);

  // Escape closes the drawer and focus returns to the seat that opened it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openAgentId]);

  const active = useMemo(
    () => agents.find((a) => a.id === activeId) ?? null,
    [agents, activeId],
  );
  const live = activeId ? seats[activeId] : undefined;

  // Auto-follow the live stream unless the user has scrolled up.
  useEffect(() => {
    if (!autoFollow || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [live?.reasoningText, live?.rawText, autoFollow, activeId]);

  function handleClose() {
    const id = openAgentId;
    onClose();
    if (id) onClosed(id);
  }

  const reasoning = live?.reasoningText ?? '';
  const answer = live?.rawText || live?.finalText || '';
  const noReasoningChannel = answer.length > 0 && reasoning.length === 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 z-40 bg-black/45"
            aria-hidden="true"
          />

          <motion.aside
            key="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Agent reasoning"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34, mass: 0.9 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l
                       border-[var(--line)] bg-[var(--bg-elev-1)] sm:w-[var(--drawer-width)]"
            style={{ boxShadow: 'var(--elev-3)' }}
          >
            <header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
              {active ? (
                <>
                  {/* Shared layout: the seat's avatar unmounts as this copy
                      mounts, in the same commit, or the animation will not run
                      (section 16.6). */}
                  <motion.div layoutId={`avatar-${active.id}`} className="h-11 w-11 rounded-[var(--radius-pill)]">
                    <Avatar
                      style={active.avatarStyle as AvatarStyle}
                      svg={active.avatarSvg}
                      iconName={active.iconName}
                      name={active.name}
                      accent={`var(${active.accentToken})`}
                      size={44}
                    />
                  </motion.div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-[var(--text)]">
                      {active.name}
                    </p>
                    <p className="tnum text-[11px] text-[var(--text-mute)]">
                      {active.provider}, {active.modelId},{' '}
                      {live?.status === 'thinking' ? 'thinking' : (live?.status ?? 'idle')}
                      {live && live.tokensOut > 0 ? `, ${live.tokensOut} tok` : ''}
                    </p>
                  </div>
                </>
              ) : (
                <div className="flex-1" />
              )}

              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-mute)]">
                <input
                  type="checkbox"
                  checked={autoFollow}
                  onChange={(e) => setAutoFollow(e.target.checked)}
                  className="accent-[var(--gold)]"
                />
                Follow
              </label>

              <Button ref={closeRef} variant="ghost" size="icon" onClick={handleClose} aria-label="Close reasoning">
                <X className="h-4 w-4" />
              </Button>
            </header>

            {/* Tabs across the top for each seat. */}
            <div
              role="tablist"
              aria-label="Seats"
              className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-3 py-2"
            >
              {agents.map((a) => {
                const state = seats[a.id]?.status ?? 'idle';
                const selected = a.id === activeId;
                return (
                  <button
                    key={a.id}
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setActiveId(a.id)}
                    className={[
                      'flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 py-1',
                      'text-[11px] transition-colors',
                      selected
                        ? 'border-[var(--line-strong)] bg-[var(--bg-elev-3)] text-[var(--text)]'
                        : 'border-transparent text-[var(--text-mute)] hover:text-[var(--text-dim)]',
                    ].join(' ')}
                    title={a.name}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-[var(--radius-pill)]"
                      style={{
                        background: `var(${a.accentToken})`,
                        opacity: state === 'idle' ? 0.35 : 1,
                      }}
                    />
                    <span className="max-w-[6.5rem] truncate">{a.name}</span>
                  </button>
                );
              })}
            </div>

            {/* layoutScroll: the shared layout animation must not fight the
                internal scroll (section 16.6). */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4" onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              if (!atBottom && autoFollow) setAutoFollow(false);
            }}>
              {!active ? (
                <p className="text-[13px] text-[var(--text-mute)]">
                  Pick a seat to watch its reasoning.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {reasoning ? (
                    <section>
                      <h4 className="step-label mb-2 text-[var(--text-mute)]">Reasoning</h4>
                      {/* Rendered as plain text; the typewriter reveal is a CSS
                          mask over already-rendered text, not a per-character
                          animation (section 16.13). */}
                      <p className="animate-typewriter whitespace-pre-wrap text-[12.5px] italic leading-relaxed text-[var(--text-mute)]">
                        {reasoning}
                      </p>
                    </section>
                  ) : null}

                  <section>
                    <h4 className="step-label mb-2 text-[var(--text-mute)]">
                      {reasoning ? 'Output' : 'Output (no separate reasoning channel)'}
                    </h4>
                    {noReasoningChannel && !reasoning ? (
                      <p className="mb-2 rounded-md border border-[var(--line)] bg-[var(--bg-elev-2)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-mute)]">
                        This model does not expose its reasoning.
                      </p>
                    ) : null}
                    <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-[var(--text)]">
                      {answer || '—'}
                    </pre>
                  </section>

                  {live?.error ? (
                    <section>
                      <h4 className="step-label mb-2 text-[var(--danger)]">Error</h4>
                      <pre className="whitespace-pre-wrap text-[12px] text-[var(--danger)]">
                        {live.error.code}: {live.error.message}
                      </pre>
                    </section>
                  ) : null}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
