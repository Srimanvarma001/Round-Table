'use client';

import { useEffect, useRef, useState } from 'react';

import { RADIUS_X, RADIUS_Y, TABLE_ASPECT } from '@/shared/constants';

/**
 * Responsive layout tiers, section 16.11.
 *
 *   full    1280px and above | full ellipse, table SVG visible
 *   wide    900 to 1279px    | same ellipse, RADIUS_X at 0.42, 52px seat floor
 *   narrow  640 to 899px     | table SVG hidden, tighter ellipse
 *   compact below 640px      | ellipse abandoned, vertical SeatStack
 *
 * The compact layout is a real layout, not a degraded one: it is what the
 * replay view uses for a run read on a phone, and it MUST be designed rather
 * than fall out of a breakpoint accident.
 */

export type LayoutTier = 'full' | 'wide' | 'narrow' | 'compact';

export interface LayoutMetrics {
  tier: LayoutTier;
  /** Container width in CSS pixels, measured. */
  width: number;
  /** Container height in CSS pixels, measured. */
  height: number;
  radiusX: number;
  radiusY: number;
  /** Seat diameter in CSS pixels, after the clamp and the floor. */
  seatDiameter: number;
  showTableSurface: boolean;
  compactBubble: boolean;
  /**
   * Set when the computed screen-space arc gap falls below
   * `seatDiameter × 1.35`: the spec says apply the compact layout rather than
   * shrink the seats further (section 16.1).
   */
  arcGapTooSmall: boolean;
}

function tierFor(width: number): LayoutTier {
  if (width >= 1280) return 'full';
  if (width >= 900) return 'wide';
  if (width >= 640) return 'narrow';
  return 'compact';
}

/** `clamp(52px, 7.2vw, 92px)` from section 16.1, resolved against the viewport. */
function seatDiameterFor(viewportWidth: number, tier: LayoutTier): number {
  const clamped = Math.min(92, Math.max(52, viewportWidth * 0.072));
  // Between 900 and 1279 the spec pins the diameter at its 52px floor.
  if (tier === 'wide') return Math.min(clamped, 60);
  return clamped;
}

export function useLayoutTier(ref: React.RefObject<HTMLElement | null>, seatCount: number): LayoutMetrics {
  const [metrics, setMetrics] = useState<LayoutMetrics>({
    tier: 'full',
    width: 1440,
    height: 1440 / TABLE_ASPECT,
    radiusX: RADIUS_X,
    radiusY: RADIUS_Y,
    seatDiameter: 92,
    showTableSurface: true,
    compactBubble: false,
    arcGapTooSmall: false,
  });

  const raf = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const width = rect.width || window.innerWidth;
      const height = rect.height || width / TABLE_ASPECT;
      const tier = tierFor(width);

      const radiusX = tier === 'full' ? RADIUS_X : tier === 'wide' ? 0.42 : 0.4;
      const radiusY = tier === 'full' ? RADIUS_Y : tier === 'wide' ? 0.4 : 0.38;
      const seatDiameter = seatDiameterFor(window.innerWidth, tier);

      // Screen-space gap between adjacent seats, approximating the ellipse's
      // perimeter with Ramanujan's second approximation and dividing by n.
      const a = radiusX * width;
      const b = radiusY * height;
      const h = ((a - b) ** 2) / ((a + b) ** 2);
      const perimeter = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
      const gap = seatCount > 1 ? perimeter / seatCount : perimeter;
      const arcGapTooSmall = gap < seatDiameter * 1.35;

      setMetrics({
        tier,
        width,
        height,
        radiusX,
        radiusY,
        seatDiameter,
        showTableSurface: tier === 'full' || tier === 'wide',
        compactBubble: tier === 'wide' || tier === 'narrow',
        arcGapTooSmall,
      });
    };

    const schedule = () => {
      if (raf.current != null) return;
      raf.current = window.requestAnimationFrame(() => {
        raf.current = null;
        measure();
      });
    };

    measure();

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener('resize', schedule);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf.current != null) window.cancelAnimationFrame(raf.current);
    };
  }, [ref, seatCount]);

  return metrics;
}
