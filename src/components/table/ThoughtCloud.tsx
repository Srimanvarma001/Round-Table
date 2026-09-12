'use client';

import { motion } from 'framer-motion';

/**
 * Layer 2 of the thinking indicator, section 16.5.
 *
 * The classic typing indicator, and the right pattern because it is universally
 * readable and costs nothing.
 *
 * Why the cloud and not a bare dot row: the tail anchors it to the seat's
 * head. Unanchored, the dots float and read as a page-level loader rather than
 * as one seat's activity. Anchoring is what makes eight simultaneous clouds
 * legible.
 *
 * Under `prefers-reduced-motion` this renders a static ellipsis glyph instead
 * of pulsing dots (section 16.12) — a state change with no motion.
 */
export function ThoughtCloud({
  accent,
  reduced = false,
  onClick,
  label = 'Show reasoning',
}: {
  accent: string;
  reduced?: boolean;
  onClick?: () => void;
  label?: string;
}) {
  if (reduced) {
    return (
      <div
        role="button"
        tabIndex={-1}
        onClick={onClick}
        aria-label={label}
        className="absolute -top-11 left-1/2 flex h-7 -translate-x-1/2 items-center justify-center
                   rounded-[var(--radius-pill)] border border-[var(--line)] bg-[var(--bg-elev-2)]
                   px-3 text-[13px] leading-none text-[var(--text-dim)]"
        style={{ borderColor: `${accent}44` }}
      >
        <span aria-hidden="true">···</span>
      </div>
    );
  }

  return (
    <motion.div
      role="button"
      tabIndex={-1}
      onClick={onClick}
      aria-label={label}
      className="absolute -top-11 left-1/2 flex -translate-x-1/2 items-center gap-[5px]
                 rounded-[var(--radius-pill)] border border-[var(--line)] bg-[var(--bg-elev-2)]
                 px-2.5 py-2"
      style={{ borderColor: `${accent}44`, boxShadow: 'var(--elev-1)' }}
      initial={{ opacity: 0, y: 6, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.92 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1.5 w-1.5 rounded-[var(--radius-pill)]"
          style={{ background: accent }}
          animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0], scale: [0.85, 1.1, 0.85] }}
          transition={{ duration: 1.15, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }}
        />
      ))}
      {/* tail */}
      <span
        aria-hidden="true"
        className="absolute -bottom-[5px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45
                   border-b border-r border-[var(--line)] bg-[var(--bg-elev-2)]"
      />
    </motion.div>
  );
}

/**
 * The error pose that replaces the cloud on a failed seat (section 16.4).
 * State is never encoded in colour alone, so this carries an icon and the
 * error code as text.
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
      className="absolute -top-11 left-1/2 flex -translate-x-1/2 items-center gap-1.5
                 rounded-[var(--radius-pill)] border border-[var(--danger)]/50 bg-[var(--bg-elev-2)]
                 px-2.5 py-1.5 text-[11px] text-[var(--danger)]"
      style={{ boxShadow: 'var(--elev-1)' }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="max-w-[7rem] truncate">{message}</span>
    </div>
  );
}
