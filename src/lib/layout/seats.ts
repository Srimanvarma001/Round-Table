/**
 * Seat layout math, section 16.1.
 *
 * The `arcLength`, `tAtArcLength` and `placeSeats` functions below are copied
 * verbatim from the specification. They are correct as written; do not
 * "improve" them. Arc-length spacing is what keeps the seats evenly spaced on
 * an ellipse, where equal ANGLE spacing bunches them at the flat left and
 * right extremes (section 16.1 explains why).
 *
 * This module is pure arithmetic and imports nothing from `lib/*`, so both the
 * client table and the unit tests can use it.
 */

import { RADIUS_X, RADIUS_Y } from '@/shared/constants';

export interface SeatPlacement {
  /** Percentage of container width, 0 to 100. */
  x: number;
  /** Percentage of container height, 0 to 100. */
  y: number;
  /** Ellipse parameter in radians. Used to orient the seat's rim highlight. */
  t: number;
}

/** Arc length of the ellipse (a·cos t, b·sin t) from 0 to t, by Simpson's rule. */
function arcLength(a: number, b: number, t: number, steps = 128): number {
  const dt = t / steps;
  const speed = (u: number) => Math.hypot(-a * Math.sin(u), b * Math.cos(u));

  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = i * dt;
    const tm = t0 + dt / 2;
    const t1 = t0 + dt;
    sum += (dt / 6) * (speed(t0) + 4 * speed(tm) + speed(t1));
  }
  return sum;
}

/** Invert arc length: the parameter t at which the arc length equals target. */
function tAtArcLength(a: number, b: number, target: number): number {
  let lo = 0;
  let hi = Math.PI * 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (arcLength(a, b, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Place n seats at equal arc-length spacing around an ellipse.
 * radiusX and radiusY are fractions of the container, 0 to 0.5.
 * Index 0 is the Me Agent, seated at the head of the table, 12 o'clock.
 * Remaining seats proceed clockwise in order_index order.
 */
export function placeSeats(n: number, radiusX: number, radiusY: number): SeatPlacement[] {
  const total = arcLength(radiusX, radiusY, Math.PI * 2);
  const step = total / n;
  const head = total * 0.75; // t = 3π/2 is 12 o'clock when y grows downward

  return Array.from({ length: n }, (_, i) => {
    const target = (head + i * step) % total;
    const t = tAtArcLength(radiusX, radiusY, target);
    return {
      x: 50 + radiusX * 100 * Math.cos(t),
      y: 50 + radiusY * 100 * Math.sin(t),
      t,
    };
  });
}

// ---------------------------------------------------------------------------
// Table geometry defaults (section 16.1)
// ---------------------------------------------------------------------------

/**
 * Re-exported from `shared/constants` so layout consumers have one import.
 * 0.45 / 0.42 of the container: the seats sit just outside the table rim.
 */
export const SEAT_RADIUS_X = RADIUS_X;
export const SEAT_RADIUS_Y = RADIUS_Y;

/** Desktop container aspect ratio, `16 / 10` (section 16.1). */
export const TABLE_ASPECT = 16 / 10;

/** `clamp(52px, 7.2vw, 92px)`. */
export const SEAT_DIAMETER_MIN_PX = 52;
export const SEAT_DIAMETER_VW = 7.2;
export const SEAT_DIAMETER_MAX_PX = 92;

/** Minimum gap between adjacent seat centres before the compact layout applies. */
export const MIN_ARC_GAP_FACTOR = 1.35;

/**
 * Seat diameter for a viewport width: `clamp(52px, 7.2vw, 92px)`.
 * Shrinking the seat is the first response to a narrowing viewport; when the
 * computed gap still falls below `seatDiameter × 1.35`, the responsive rules
 * in `LAYOUT_BREAKPOINTS` take over instead of shrinking any further.
 */
export function seatDiameterFor(width: number): number {
  const vw = width * (SEAT_DIAMETER_VW / 100);
  return Math.min(SEAT_DIAMETER_MAX_PX, Math.max(SEAT_DIAMETER_MIN_PX, vw));
}

// ---------------------------------------------------------------------------
// Responsive rules (section 16.11)
// ---------------------------------------------------------------------------

export type SeatLayoutMode = 'ellipse' | 'ellipse-tight' | 'stack';
export type ReasoningPanelMode = 'sheet' | 'overlay' | 'fullscreen';

export interface LayoutBreakpoint {
  /** Inclusive lower bound in CSS px. */
  minWidth: number;
  /** Exclusive upper bound in CSS px, or null for the top band. */
  maxWidth: number | null;
  mode: SeatLayoutMode;
  /** Ellipse radii for this band. Null once the ellipse is abandoned. */
  radiusX: number | null;
  radiusY: number | null;
  /** Table SVG visibility. */
  tableSurfaceVisible: boolean;
  /** Bubble width cap in rem, null when the band does not constrain it. */
  bubbleMaxRem: number | null;
  reasoningPanel: ReasoningPanelMode;
  /** Short restatement of the band's rule, section 16.11. */
  note: string;
}

/**
 * The four bands of section 16.11, narrowest last. `radiusX` is read from the
 * spec where it states one; the 640 to 899 band only says "a tighter ellipse",
 * so 0.40 / 0.36 is this implementation's choice under the "where this
 * document is silent, choose the simplest implementation" rule.
 */
export const LAYOUT_BREAKPOINTS: readonly LayoutBreakpoint[] = [
  {
    minWidth: 1280,
    maxWidth: null,
    mode: 'ellipse',
    radiusX: RADIUS_X,
    radiusY: RADIUS_Y,
    tableSurfaceVisible: true,
    bubbleMaxRem: null,
    reasoningPanel: 'sheet',
    note: 'Full ellipse, table SVG visible, drawer as a right sheet.',
  },
  {
    minWidth: 900,
    maxWidth: 1280,
    mode: 'ellipse-tight',
    radiusX: 0.42,
    radiusY: RADIUS_Y,
    tableSurfaceVisible: true,
    bubbleMaxRem: 9,
    reasoningPanel: 'sheet',
    note: 'Same ellipse with radiusX at 0.42, seat diameter at its 52px floor, bubbles narrow to 9rem and clamp to one line.',
  },
  {
    minWidth: 640,
    maxWidth: 900,
    mode: 'ellipse-tight',
    radiusX: 0.4,
    radiusY: 0.36,
    tableSurfaceVisible: false,
    bubbleMaxRem: 9,
    reasoningPanel: 'overlay',
    note: 'Table SVG hidden, seats on a tighter ellipse, reasoning panel becomes a full-screen overlay.',
  },
  {
    minWidth: 0,
    maxWidth: 640,
    mode: 'stack',
    radiusX: null,
    radiusY: null,
    tableSurfaceVisible: false,
    bubbleMaxRem: null,
    reasoningPanel: 'fullscreen',
    note: 'Compact layout: the ellipse is abandoned. Seats become a vertical SeatStack of rows; the step timeline becomes a horizontally scrollable strip; the vote plinth becomes a full-width list.',
  },
];

/**
 * Rectangular wireframe layout: portrait table with 8 outlined slots —
 * 1 top (You, head of table), 3 down the left, 3 down the right, 1 bottom.
 *
 * Index 0 is the Me Agent at top-centre. Clockwise order is preserved:
 * 0 top, 1 right-top, 2 right-middle, 3 right-bottom, 4 bottom,
 * 5 left-bottom, 6 left-middle, 7 left-top.
 *
 * Coordinates are percentages of the table-area container (0-100), kept well
 * clear of the central portrait rectangle (x ~37-63, y ~21-79) so bubbles
 * never overlap neighbouring seats.
 */
export type RectSeatSide = 'top' | 'right' | 'bottom' | 'left';

export interface RectSeatPlacement {
  x: number;
  y: number;
  side: RectSeatSide;
  /** Position of the bubble tail: away from the table, never over a neighbour. */
  bubbleSide: 'above' | 'below' | 'left' | 'right';
}

export function placeRectSeats(n: number): RectSeatPlacement[] {
  if (n <= 0) return [];
  // Canonical 8-seat wireframe. For other counts fall back to repeating the
  // side pattern so previews and tests never crash.
  const canonical: RectSeatPlacement[] = [
    { x: 50, y: 7, side: 'top', bubbleSide: 'above' },
    { x: 81, y: 26, side: 'right', bubbleSide: 'right' },
    { x: 81, y: 50, side: 'right', bubbleSide: 'right' },
    { x: 81, y: 74, side: 'right', bubbleSide: 'right' },
    { x: 50, y: 93, side: 'bottom', bubbleSide: 'below' },
    { x: 19, y: 74, side: 'left', bubbleSide: 'left' },
    { x: 19, y: 50, side: 'left', bubbleSide: 'left' },
    { x: 19, y: 26, side: 'left', bubbleSide: 'left' },
  ];
  if (n === 8) return canonical;
  return Array.from({ length: n }, (_, i) => canonical[i % canonical.length]);
}

/** The band that applies at a given viewport width. */
export function layoutForWidth(width: number): LayoutBreakpoint {
  return (
    LAYOUT_BREAKPOINTS.find(
      (band) => width >= band.minWidth && (band.maxWidth === null || width < band.maxWidth),
    ) ?? LAYOUT_BREAKPOINTS[LAYOUT_BREAKPOINTS.length - 1]
  );
}

/**
 * Place seats for a container of a given size, applying the responsive band.
 * Returns an empty array in the compact band, where the caller renders
 * `SeatStack` instead of absolutely positioned seats.
 */
export function placeSeatsForWidth(
  n: number,
  width: number,
): { band: LayoutBreakpoint; placements: SeatPlacement[] } {
  const band = layoutForWidth(width);
  if (band.radiusX === null || band.radiusY === null) {
    return { band, placements: [] };
  }
  return { band, placements: placeSeats(n, band.radiusX, band.radiusY) };
}
