'use client';

import { AlertTriangle } from 'lucide-react';

import type { AgentDTO } from '@/shared/types';

/**
 * Live normalised percentages, section 15.3, with the over-50-percent warning
 * the spec asks for.
 *
 * This is an EDITOR PREVIEW and nothing more. It runs the same normalisation
 * over the *unsaved* local draft so a weight slider has a visible consequence
 * the instant it moves (section 12.1: "weight editing is the one change that
 * must be visible the instant it is made"). It is not scoring: the client never
 * computes weighted run scores during a session (section 15.2). The authoritative
 * set is the one the server returns with every write, and the one frozen into
 * `runs.agent_snapshot` when a run starts.
 *
 * Normalisation covers the ENABLED seats only, so toggling a seat off rebalances
 * the rest with no manual weight editing (section 12.1).
 */

/** A single seat above this share of the vote is worth flagging. */
export const WEIGHT_WARN_THRESHOLD = 0.5;

export interface WeightPreviewProps {
  /** The draft list, already ordered by `orderIndex`. */
  agents: AgentDTO[];
  /** Normalised weights for the draft, from `useNormalisedPreview`. */
  normalised: Record<string, number>;
  className?: string;
}

export function WeightPreview({ agents, normalised, className = '' }: WeightPreviewProps) {
  const enabled = agents.filter((a) => a.enabled);
  const rawTotal = enabled.reduce((sum, a) => sum + Math.max(0, a.weight), 0);
  const over = enabled.filter((a) => (normalised[a.id] ?? 0) > WEIGHT_WARN_THRESHOLD);
  const activeCount = enabled.length;

  return (
    <section className={`flex flex-col gap-3 ${className}`} aria-labelledby="weight-preview-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="weight-preview-heading" className="step-label text-[var(--text-mute)]">
          Normalised weight preview
        </h3>
        <span className="tnum text-[11px] text-[var(--text-mute)]">
          raw total {rawTotal.toFixed(3)}
        </span>
      </div>

      {activeCount === 0 ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--danger)]/40
                     bg-[var(--danger)]/10 px-3 py-2 text-[12px] text-[var(--danger)]"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          No seats are enabled. A run cannot start — normalisation needs at least one enabled seat.
        </p>
      ) : null}

      {over.length > 0 ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--warn)]/40
                     bg-[var(--warn)]/10 px-3 py-2 text-[12px] text-[var(--warn)]"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {over.map((a) => a.name).join(', ')} carr
            {over.length === 1 ? 'ies' : 'y'} more than{' '}
            <span className="tnum">50%</span> of the vote. Past that point a single seat decides the
            winner on its own, which is rarely what a council is for.
          </span>
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {agents.map((agent) => {
          const share = agent.enabled ? (normalised[agent.id] ?? 0) : 0;
          const accent = `var(${agent.accentToken})`;
          return (
            <li key={agent.id} className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-[var(--radius-pill)]"
                style={{ background: accent, opacity: agent.enabled ? 1 : 0.3 }}
              />
              <span
                className={[
                  'w-[9.5rem] shrink-0 truncate text-[12px]',
                  agent.enabled ? 'text-[var(--text-dim)]' : 'text-[var(--text-mute)] line-through',
                ].join(' ')}
              >
                {agent.name}
              </span>

              <span
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--bg-elev-3)]"
                role="img"
                aria-label={`${agent.name}: ${(share * 100).toFixed(1)} percent of the vote`}
              >
                <span
                  className="block h-full rounded-[var(--radius-pill)]"
                  style={{
                    width: `${Math.min(100, share * 100)}%`,
                    background: accent,
                    opacity: agent.enabled ? 1 : 0.3,
                  }}
                />
              </span>

              <span className="tnum w-[3.6rem] shrink-0 text-right text-[12px] font-medium text-[var(--text)]">
                {(share * 100).toFixed(1)}%
              </span>

              <span className="tnum w-[3.4rem] shrink-0 text-right text-[11px] text-[var(--text-mute)]">
                {agent.enabled ? `w ${Math.max(0, agent.weight).toFixed(3)}` : 'disabled'}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] leading-relaxed text-[var(--text-mute)]">
        Editor preview over the unsaved draft. Weights are normalised across the{' '}
        <span className="tnum">{activeCount}</span> enabled seat
        {activeCount === 1 ? '' : 's'}; the server recomputes this on every save and freezes the
        result into the run snapshot when a run starts.
      </p>
    </section>
  );
}
