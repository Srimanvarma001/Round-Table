import { describe, expect, it } from 'vitest';

import {
  LAYOUT_BREAKPOINTS,
  layoutForWidth,
  placeSeats,
  placeSeatsForWidth,
  seatDiameterFor,
} from '@/lib/layout/seats';
import { RADIUS_X, RADIUS_Y } from '@/shared/constants';

/**
 * Section 16.1 and section 19.1.
 *
 * The property that matters is that seats are spaced by ARC LENGTH, not by
 * angle. Equal angle spacing bunches seats at the flat left and right extremes
 * of an ellipse, which is the bug these tests exist to prevent. The arc-length
 * integral below is a deliberately independent reimplementation (different
 * step count) so it can disagree with the module under test.
 */
function arcLengthAt(t: number, a = RADIUS_X, b = RADIUS_Y, steps = 4096): number {
  const dt = t / steps;
  const speed = (u: number) => Math.hypot(-a * Math.sin(u), b * Math.cos(u));
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = i * dt;
    sum += (dt / 6) * (speed(t0) + 4 * speed(t0 + dt / 2) + speed(t0 + dt));
  }
  return sum;
}

describe('placeSeats', () => {
  it.each([2, 3, 8, 16])('returns exactly %i placements', (n) => {
    expect(placeSeats(n, RADIUS_X, RADIUS_Y)).toHaveLength(n);
  });

  it.each([2, 3, 8, 16])('keeps every coordinate inside 0 to 100 at n=%i', (n) => {
    for (const seat of placeSeats(n, RADIUS_X, RADIUS_Y)) {
      expect(seat.x).toBeGreaterThanOrEqual(0);
      expect(seat.x).toBeLessThanOrEqual(100);
      expect(seat.y).toBeGreaterThanOrEqual(0);
      expect(seat.y).toBeLessThanOrEqual(100);
    }
  });

  it.each([2, 3, 8, 16])('spaces adjacent seats uniformly by arc length at n=%i', (n) => {
    const seats = placeSeats(n, RADIUS_X, RADIUS_Y);
    const total = arcLengthAt(Math.PI * 2);

    // Arc position of each seat, measured from the head of the table so the
    // wrap-around between the last seat and the first is included.
    //
    // The independent integral here uses 4096 steps against the module's 128,
    // so the head seat's offset lands on either 0 or `total` depending on which
    // way the last bit rounds. Rebasing on the minimum makes the test
    // indifferent to that, which is what a circular measure should be.
    const positions = seats.map((s) => arcLengthAt(s.t));
    const head = total * 0.75;
    const raw = positions.map((p) => (p - head + total) % total);
    const base = Math.min(...raw);

    const offsets = raw.map((o) => (o - base + total) % total).sort((a, b) => a - b);

    // n gaps, not n − 1: every seat has a successor, and the last one's
    // successor is the head, reached by wrapping through the end of the
    // ellipse. Offsets are rebased to start at 0, so the wrap is the only
    // gap that spans the origin.
    const gaps = offsets.map((o, i) => {
      const previous = i === 0 ? offsets[offsets.length - 1] - total : offsets[i - 1];
      return o - previous;
    });

    expect(gaps).toHaveLength(n);

    const mean = total / n;
    for (const gap of gaps) {
      expect(Math.abs(gap - mean) / mean).toBeLessThan(0.02);
    }
  });

  it('proves the spacing is arc-length based by showing angle spacing would fail', () => {
    const n = 8;
    const seats = placeSeats(n, RADIUS_X, RADIUS_Y);

    // Consecutive seats are NOT evenly spaced in the ellipse parameter t.
    // If they were, this would be angle spacing rather than arc-length spacing.
    const TAU = Math.PI * 2;
    const tGaps: number[] = [];
    for (let i = 1; i < n; i++) tGaps.push((seats[i].t - seats[i - 1].t + TAU) % TAU);
    const meanT = tGaps.reduce((s, g) => s + g, 0) / tGaps.length;
    const maxDeviation = Math.max(...tGaps.map((g) => Math.abs(g - meanT) / meanT));

    expect(maxDeviation).toBeGreaterThan(0.02);
  });

  it('seats index 0 at the head of the table, 12 o\'clock', () => {
    const [me] = placeSeats(8, RADIUS_X, RADIUS_Y);

    expect(me.x).toBeCloseTo(50, 6);
    // y grows downward in the SVG viewBox, so 12 o'clock is above centre.
    expect(me.y).toBeCloseTo(50 - RADIUS_Y * 100, 6);
    expect(me.y).toBeLessThan(50);
  });

  it('places the remaining seats clockwise, in order', () => {
    const seats = placeSeats(8, RADIUS_X, RADIUS_Y);

    // Clockwise from 12 o'clock on a downward-y axis means x increases first:
    // the second seat sits to the right of the head.
    expect(seats[1].x).toBeGreaterThan(50);
    expect(seats[1].y).toBeLessThan(50);
    // And the seat diametrically opposite the head sits at the foot.
    expect(seats[4].y).toBeCloseTo(50 + RADIUS_Y * 100, 6);
  });

  it('is deterministic', () => {
    expect(placeSeats(8, RADIUS_X, RADIUS_Y)).toEqual(placeSeats(8, RADIUS_X, RADIUS_Y));
  });

  it('returns an empty array for zero seats rather than throwing', () => {
    expect(placeSeats(0, RADIUS_X, RADIUS_Y)).toEqual([]);
  });
});

describe('responsive bands, section 16.11', () => {
  it('covers the whole width range with no gap and no overlap', () => {
    const ordered = [...LAYOUT_BREAKPOINTS].sort((a, b) => a.minWidth - b.minWidth);

    expect(ordered[0].minWidth).toBe(0);
    expect(ordered[ordered.length - 1].maxWidth).toBeNull();

    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].minWidth).toBe(ordered[i - 1].maxWidth);
    }
  });

  it.each([
    [1600, 'ellipse'],
    [1280, 'ellipse'],
    [1024, 'ellipse-tight'],
    [700, 'ellipse-tight'],
    [500, 'stack'],
  ])('picks the %i px band as %s', (width, mode) => {
    expect(layoutForWidth(width).mode).toBe(mode);
  });

  it('abandons the ellipse in the compact band', () => {
    const { band, placements } = placeSeatsForWidth(8, 480);

    expect(band.mode).toBe('stack');
    expect(band.radiusX).toBeNull();
    expect(band.tableSurfaceVisible).toBe(false);
    expect(placements).toEqual([]);
  });

  it('returns placements on an ellipse above the compact band', () => {
    const { band, placements } = placeSeatsForWidth(8, 1440);

    expect(band.mode).toBe('ellipse');
    expect(placements).toHaveLength(8);
  });

  it('shrinks the seat to its floor before switching layout', () => {
    expect(seatDiameterFor(400)).toBe(52);
    expect(seatDiameterFor(2000)).toBe(92);
    expect(seatDiameterFor(1000)).toBeCloseTo(72, 6);
  });
});
