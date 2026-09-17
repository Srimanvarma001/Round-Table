'use client';

import { motion } from 'framer-motion';

import type { RectSeatPlacement } from '@/lib/layout/seats';

/**
 * Minimal outlined take / thinking bubble in the wireframe's hand-drawn
 * style: thin light stroke, no fill, slightly irregular organic corners and
 * a small pointer tail aimed back at the seat.
 *
 * Positioned away from the table (via `bubbleSide`) so it never overlaps
 * neighbouring seats. One line only; the full text lives in the drawer.
 */
export function SpeechBubble({
  take,
  accent,
  compact = false,
  above = false,
  bubbleSide = 'above',
  thinking = false,
  onOpen,
}: {
  take: string;
  accent: string;
  compact?: boolean;
  /** Legacy: bottom-half seats flip the bubble above. Kept for compat. */
  above?: boolean;
  bubbleSide?: RectSeatPlacement['bubbleSide'];
  /** Thinking state renders the sketch bubble with "thinking..." text. */
  thinking?: boolean;
  onOpen?: () => void;
}) {
  const side: RectSeatPlacement['bubbleSide'] = thinking
    ? bubbleSide
    : above
      ? 'above'
      : bubbleSide;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7 }}
      onClick={onOpen}
      aria-label={thinking ? 'Agent is thinking' : undefined}
      data-sketch-bubble={thinking ? 'thinking' : 'take'}
      className={[
        'sketch-bubble absolute z-30',
        side === 'above' ? 'bottom-[calc(100%+12px)] left-1/2 -translate-x-1/2' : '',
        side === 'below' ? 'left-1/2 top-[calc(100%+12px)] -translate-x-1/2' : '',
        side === 'left' ? 'right-[calc(100%+12px)] top-1/2 -translate-y-1/2' : '',
        side === 'right' ? 'left-[calc(100%+12px)] top-1/2 -translate-y-1/2' : '',
        compact ? 'w-36' : 'w-44',
        onOpen ? 'cursor-pointer' : '',
      ].join(' ')}
      style={
        thinking
          ? { borderColor: 'rgba(127,179,146,0.55)' }
          : { borderColor: `${accent}44` }
      }
    >
      <p
        className={
          thinking
            ? 'sketch-thinking-text whitespace-nowrap text-[12px] italic'
            : 'line-clamp-1 text-[12px] leading-snug text-[var(--text-dim)]'
        }
      >
        {take}
      </p>
      <span aria-hidden="true" data-tail={side} className="sketch-tail" />
    </motion.div>
  );
}
