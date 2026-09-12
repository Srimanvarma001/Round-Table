'use client';

import { AnimatePresence, motion } from 'framer-motion';

/**
 * Layer 1 of the thinking indicator, section 16.5.
 *
 * The critical implementation detail: the `box-shadow` itself is STATIC and
 * only `opacity` and `scale` animate. Animating a box-shadow value forces a
 * paint every frame on every seat; animating opacity on a pre-shadowed element
 * is composited on the GPU. With eight seats on screen this is the difference
 * between smooth and janky (section 16.13).
 *
 * `delay` is used by section 16.10 rule 6: when more than one seat is thinking
 * the auras phase-offset by 0.4s each, so eight glows pulse in a visible wave
 * rather than in unison. Unison reads as a loading screen; a wave reads as a
 * room.
 */
export function SeatAura({
  accent,
  active,
  delay = 0,
  reduced = false,
}: {
  accent: string;
  active: boolean;
  delay?: number;
  reduced?: boolean;
}) {
  return (
    <AnimatePresence>
      {active && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2.5 rounded-[var(--radius-pill)]"
          style={{ boxShadow: `0 0 0 2px ${accent}55, 0 0 30px 6px ${accent}40` }}
          initial={{ opacity: 0, scale: 0.92 }}
          // Section 16.12: with reduced motion the aura becomes a solid,
          // non-animated ring at 60 percent opacity. State still changes; only
          // the motion is removed.
          animate={
            reduced
              ? { opacity: 0.6, scale: 1 }
              : { opacity: [0.42, 0.95, 0.42], scale: [0.97, 1.05, 0.97] }
          }
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.22 } }}
          transition={
            reduced
              ? { duration: 0.01 }
              : {
                  opacity: { duration: 2.2, repeat: Infinity, ease: 'easeInOut', delay },
                  scale: { duration: 2.2, repeat: Infinity, ease: 'easeInOut', delay },
                }
          }
        />
      )}
    </AnimatePresence>
  );
}
