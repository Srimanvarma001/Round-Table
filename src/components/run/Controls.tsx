'use client';

import { Loader2 } from 'lucide-react';

import type { ControlState } from '@/hooks/useRunStream';

/**
 * Wireframe controls for the slim right-side rail: stacked prompt field,
 * quiet Generate outline button, refine toggle, and Stop/Abort as small text
 * links. Visually quiet — thin dividers, small type, generous whitespace.
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
  const running = controls === 'running';
  const paused = controls === 'paused';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label htmlFor="seed-prompt" className="text-[11px] text-[var(--text-mute)]">
          Prompt
        </label>
        <textarea
          id="seed-prompt"
          value={seedPrompt}
          onChange={(e) => onSeedChange(e.target.value)}
          placeholder="What should the table think about?"
          aria-label="Seed prompt"
          disabled={!idle}
          rows={4}
          className="w-full resize-none rounded-[3px] border border-[var(--line-strong)] bg-transparent
                     px-2.5 py-2 text-[12.5px] leading-relaxed text-[var(--text)]
                     placeholder:text-[var(--text-mute)] disabled:opacity-60"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && idle && seedPrompt.trim()) onGenerate();
          }}
        />

        {idle ? (
          <button
            type="button"
            onClick={onGenerate}
            disabled={!seedPrompt.trim() || busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-[3px] border
                       border-[var(--line-strong)] px-3 py-1.5 text-[12px] text-[var(--text-dim)]
                       transition-colors hover:border-[var(--text-mute)] hover:text-[var(--text)]
                       disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {controls === 'done' || controls === 'error' ? 'Generate again' : 'Generate'}
          </button>
        ) : paused ? (
          <button
            type="button"
            onClick={onResume}
            className="flex w-full items-center justify-center gap-1.5 rounded-[3px] border
                       border-[rgba(201,151,63,0.5)] px-3 py-1.5 text-[12px] text-[var(--gold-hi)]"
          >
            Resume
          </button>
        ) : (
          <button
            type="button"
            onClick={onGenerate}
            className="flex w-full items-center justify-center gap-1.5 rounded-[3px] border
                       border-[var(--line-strong)] px-3 py-1.5 text-[12px] text-[var(--text-dim)]"
          >
            Regenerate
          </button>
        )}

        <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-snug text-[var(--text-mute)]">
          <input
            type="checkbox"
            checked={refineEnabled}
            onChange={(e) => onRefineChange(e.target.checked)}
            disabled={!idle}
            className="mt-0.5 accent-[var(--gold)]"
          />
          <span>Refine step</span>
        </label>
      </div>

      {/* Live run actions: small quiet text links, not bordered buttons. */}
      {!idle ? (
        <div className="flex items-center gap-3 border-t border-[var(--line)] pt-2.5 text-[11.5px]">
          {running ? (
            <button
              type="button"
              onClick={onPause}
              className="text-[var(--text-dim)] underline decoration-[var(--line-strong)] underline-offset-4 hover:text-[var(--text)]"
            >
              Stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={onAbort}
            className="text-[var(--text-dim)] underline decoration-[var(--line-strong)] underline-offset-4 hover:text-[var(--danger)]"
          >
            Abort
          </button>
          {buffered ? (
            <button
              type="button"
              onClick={onSkipAnimation}
              title="Flush buffered text"
              className="ml-auto text-[var(--text-mute)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--text-dim)]"
            >
              Skip
            </button>
          ) : null}
        </div>
      ) : buffered ? (
        <div className="border-t border-[var(--line)] pt-2.5 text-[11.5px]">
          <button
            type="button"
            onClick={onSkipAnimation}
            title="Flush buffered text"
            className="text-[var(--text-mute)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--text-dim)]"
          >
            Skip animation
          </button>
        </div>
      ) : null}
    </div>
  );
}
