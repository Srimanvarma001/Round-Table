'use client';

import { motion } from 'framer-motion';

/**
 * Speech bubble, section 16.6.
 *
 * Enters from the seat with a short upward travel, holds a maximum of two
 * lines, and truncates with a fade rather than an ellipsis mid-word.
 *
 * The bubble is NOT a chat log. It shows the seat's single most recent take,
 * replaced as the run proceeds. The full history lives in the reasoning drawer
 * and in the replay view.
 *
 * Section 16.13: streamed text MUST NOT be wrapped in a motion component.
 * Animating each token re-renders and re-lays-out the bubble hundreds of times
 * per step. So the text is plain, and only the container animates its entrance
 * once.
 */
export function SpeechBubble({
  take,
  accent,
  compact = false,
  /** Seats in the bottom half flip the bubble above the disc so the fixed
      viewport never clips it. */
  above = false,
  onOpen,
}: {
  take: string;
  accent: string;
  /** Below 1280px the bubble narrows to 9rem and clamps to one line. */
  compact?: boolean;
  above?: boolean;
  onOpen?: () => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: above ? -8 : 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: above ? -6 : 6, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7 }}
      onClick={onOpen}
      className={[
        'absolute left-1/2 z-30 -translate-x-1/2 rounded-[var(--radius-card)]',
        above ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]',
        'border bg-[var(--bg-elev-1)] px-2.5 py-1.5',
        'leading-snug text-[var(--text-dim)]',
        compact ? 'w-36 text-[11.5px]' : 'w-44 text-[12px]',
        onOpen ? 'cursor-pointer' : '',
      ].join(' ')}
      style={{ borderColor: `${accent}55`, boxShadow: 'var(--elev-2)' }}
    >
      {/* Plain text, never a motion child (section 16.13). The line clamp does
          the truncating so a long take fades out instead of breaking a word. */}
      <p className={compact ? 'line-clamp-1' : 'line-clamp-2'}>{take}</p>
    </motion.div>
  );
}
