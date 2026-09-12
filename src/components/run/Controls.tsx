'use client';

import { Loader2, Pause, Play, Square, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ControlState } from '@/hooks/useRunStream';

/**
 * Controls, section 15.3: Generate, Stop, Resume, Abort — a single primary
 * action reflecting the run status.
 *
 * The Stop button PAUSES. Section 11.4 is precise about this: it sets a flag
 * and returns immediately, in-flight calls run to completion and persist
 * normally, and resuming re-enters the same step filtering out task keys that
 * already exist. It is not an abort, and a half-finished critique is worse than
 * a slow stop.
 */

export interface ControlsProps {
  controls: ControlState;
  seedPrompt: string;
  refineEnabled: boolean;
  onSeedChange: (value: string) => void;
  onRefineChange: (value: boolean) => void;
  onGenerate: () => void;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  onSkipAnimation: () => void;
  busy?: boolean;
  /** Number of buffered deltas still draining; drives the skip control. */
  buffered: boolean;
}

export function Controls({
  controls,
  seedPrompt,
  refineEnabled,
  onSeedChange,
  onRefineChange,
  onGenerate,
  onPause,
  onResume,
  onAbort,
  onSkipAnimation,
  busy = false,
  buffered,
}: ControlsProps) {
  const idle = controls === 'idle' || controls === 'done' || controls === 'error';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          value={seedPrompt}
          onChange={(e) => onSeedChange(e.target.value)}
          placeholder="What should the table think about?"
          aria-label="Seed prompt"
          disabled={!idle}
          className="h-9 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg-elev-3)] px-3
                     text-[13px] text-[var(--text)] placeholder:text-[var(--text-mute)]
                     disabled:opacity-60"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && idle && seedPrompt.trim()) onGenerate();
          }}
        />

        {idle ? (
          <Button
            variant="primary"
            size="md"
            onClick={onGenerate}
            disabled={!seedPrompt.trim() || busy}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {controls === 'done' || controls === 'error' ? 'Generate again' : 'Generate'}
          </Button>
        ) : controls === 'running' ? (
          <>
            <Button variant="secondary" size="md" onClick={onPause}>
              <Pause className="h-3.5 w-3.5" />
              Stop
            </Button>
            <Button variant="danger" size="md" onClick={onAbort}>
              <Square className="h-3.5 w-3.5" />
              Abort
            </Button>
          </>
        ) : controls === 'paused' ? (
          <>
            <Button variant="primary" size="md" onClick={onResume}>
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
            <Button variant="danger" size="md" onClick={onAbort}>
              <Square className="h-3.5 w-3.5" />
              Abort
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="md" onClick={onGenerate}>
            Regenerate
          </Button>
        )}

        {/* Section 16.10 rule 8: a "skip animation" control on the table flushes
            everything immediately, for when the user wants the result rather
            than the show. */}
        {buffered ? (
          <Button variant="ghost" size="md" onClick={onSkipAnimation} title="Flush buffered text">
            <Zap className="h-3.5 w-3.5" />
            Skip
          </Button>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-[11.5px] text-[var(--text-mute)]">
        <input
          type="checkbox"
          checked={refineEnabled}
          onChange={(e) => onRefineChange(e.target.checked)}
          disabled={!idle}
          className="accent-[var(--seat-5)]"
        />
        Run the refine step (skipped automatically when no proposal drew a critique)
      </label>
    </div>
  );
}
