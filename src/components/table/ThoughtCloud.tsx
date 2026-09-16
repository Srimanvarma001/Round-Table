'use client';

import { SpeechBubble } from '@/components/table/SpeechBubble';
import type { RectSeatPlacement } from '@/lib/layout/seats';

/**
 * Thinking indicator: the hand-drawn sketch bubble with "thinking..." text
 * and a pointer tail toward the seat. Thin outline, no fill, casual border.
 */
export function ThoughtCloud({
  accent,
  reduced = false,
  bubbleSide = 'above',
  onClick,
  label = 'Show reasoning',
}: {
  accent: string;
  reduced?: boolean;
  bubbleSide?: RectSeatPlacement['bubbleSide'];
  onClick?: () => void;
  label?: string;
}) {
  void reduced;
  void label;
  return (
    <SpeechBubble
      take="thinking..."
      accent={accent}
      thinking
      bubbleSide={bubbleSide}
      onOpen={onClick}
    />
  );
}

/**
 * The error pose that replaces the cloud on a failed seat.
 * State is never encoded in colour alone, so this carries the error code.
 */
export function FailedIndicator({
  message,
  onClick,
  label = 'Show error',
}: {
  message: string;
  onClick?: () => void;
  label?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onClick}
      aria-label={label}
      title={message}
      className="sketch-bubble absolute left-1/2 top-[calc(100%+12px)] z-30 w-36 -translate-x-1/2
                 px-2.5 py-1.5 text-[11px] text-[var(--danger)]"
      style={{ borderColor: 'var(--danger)' }}
    >
      <span className="block truncate">{message}</span>
      <span aria-hidden="true" data-tail="below" className="sketch-tail" />
    </div>
  );
}
