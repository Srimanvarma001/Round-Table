'use client';

import { useEffect, useState } from 'react';

/**
 * Section 16.12. When `prefers-reduced-motion` is set the stagger cadence drops
 * to zero, ThoughtCloud renders a static ellipsis instead of pulsing dots, and
 * SeatAura renders a solid non-animated ring at 60 percent opacity.
 *
 * State changes still occur; only the motion is removed.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);

    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
