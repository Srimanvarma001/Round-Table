import { describe, expect, it } from 'vitest';

import {
  activeSeatsFor,
  advance,
  DEFAULT_ADVANCE_OPTIONS,
  emptyRevealBuffer,
  FAST_RELEASE_CHARS,
  finishSeat,
  flushAllBuffers,
  isActiveBuffer,
  isPassThrough,
  receiveDelta,
  RELEASE_CHARS,
  type RevealBuffers,
} from '@/lib/stagger/reveal';
import { STAGGER_HIGH_WATER_CHARS } from '@/shared/constants';

/** Put `text` in a seat's buffer without pacing it through. */
function seed(entries: Record<string, string>): RevealBuffers {
  let buffers: RevealBuffers = {};
  for (const [id, text] of Object.entries(entries)) {
    buffers = receiveDelta(buffers, id, text, false);
  }
  return buffers;
}

describe('buffering, rule 1', () => {
  it('never renders a delta immediately', () => {
    const buffers = seed({ a: 'hello' });

    expect(buffers.a.visible).toBe('');
    expect(buffers.a.queue).toBe('hello');
    expect(buffers.a.done).toBe(false);
  });

  it('appends rather than replaces across deltas', () => {
    let buffers = seed({ a: 'hel' });
    buffers = receiveDelta(buffers, 'a', 'lo', false);

    expect(buffers.a.queue).toBe('hello');
  });

  it('ignores an empty delta without allocating', () => {
    const buffers = seed({ a: 'hello' });
    expect(receiveDelta(buffers, 'a', '', false)).toBe(buffers);
  });
});

describe('release order, rule 2', () => {
  it('releases one slot per tick, rotating through seats in order_index order', () => {
    let buffers = seed({ seat_a: 'aaaaaa', seat_b: 'bbbbbb', seat_c: 'cccccc' });
    const order = ['seat_a', 'seat_b', 'seat_c'];

    const tick1 = advance(buffers, order, 0);
    expect(tick1.buffers.seat_a.visible).toBe('aaa');
    expect(tick1.buffers.seat_b.visible).toBe('');
    expect(tick1.buffers.seat_c.visible).toBe('');

    const tick2 = advance(tick1.buffers, order, tick1.cursor);
    expect(tick2.buffers.seat_b.visible).toBe('bbb');
    expect(tick2.buffers.seat_c.visible).toBe('');

    const tick3 = advance(tick2.buffers, order, tick2.cursor);
    expect(tick3.buffers.seat_c.visible).toBe('ccc');

    // And back around to the first seat.
    const tick4 = advance(tick3.buffers, order, tick3.cursor);
    expect(tick4.buffers.seat_a.visible).toBe('aaaaaa');
  });

  it('follows the order it is given, not insertion order', () => {
    const buffers = seed({ seat_a: 'aaaaaa', seat_b: 'bbbbbb' });

    // The caller passes seats already sorted by order_index; seat_b is first.
    const result = advance(buffers, ['seat_b', 'seat_a'], 0);

    expect(result.buffers.seat_b.visible).toBe('bbb');
    expect(result.buffers.seat_a.visible).toBe('');
  });

  it('releases nothing and reports no change when every seat is idle', () => {
    const result = advance({}, ['seat_a'], 0);

    expect(result.changed).toBe(false);
    expect(result.buffers).toEqual({});
  });

  it('skips a seat that has drained and finished, moving to the next', () => {
    let buffers = seed({ seat_a: 'abc', seat_b: 'bbbbbb' });
    buffers = finishSeat(buffers, 'seat_a');
    const drained = advance(buffers, ['seat_a', 'seat_b'], 0);
    // seat_a is done, so it drains fast and is gone; only seat_b is left active.
    expect(drained.buffers.seat_a.queue).toBe('');
    expect(drained.buffers.seat_a.visible).toBe('abc');

    const next = advance(drained.buffers, ['seat_a', 'seat_b'], drained.cursor);
    expect(next.buffers.seat_b.visible).toBe('bbb');
  });
});

describe('high-water mark, rule 3', () => {
  it('accelerates a seat whose buffer exceeds the mark', () => {
    const big = 'x'.repeat(STAGGER_HIGH_WATER_CHARS + 500);
    const buffers = seed({ seat_big: big, seat_small: 'y'.repeat(20) });

    const result = advance(buffers, ['seat_big', 'seat_small'], 0);

    // The over-mark seat drains through the accelerated pass AND takes the
    // rotation slot; the control seat gets nothing this tick.
    expect(result.buffers.seat_big.visible.length).toBe(FAST_RELEASE_CHARS + RELEASE_CHARS);
    expect(result.buffers.seat_small.visible.length).toBe(0);
  });

  it('keeps releasing the over-mark seat on later ticks even without the slot', () => {
    const big = 'x'.repeat(STAGGER_HIGH_WATER_CHARS + 500);
    const buffers = seed({ seat_big: big, seat_small: 'y'.repeat(20) });

    const tick1 = advance(buffers, ['seat_big', 'seat_small'], 0);
    const tick2 = advance(tick1.buffers, ['seat_big', 'seat_small'], tick1.cursor);

    // The slot went to seat_small, but seat_big still drained at the fast rate.
    expect(tick2.buffers.seat_small.visible.length).toBe(RELEASE_CHARS);
    expect(tick2.buffers.seat_big.visible.length).toBe(
      FAST_RELEASE_CHARS + RELEASE_CHARS + FAST_RELEASE_CHARS,
    );
  });

  it('drains an over-mark buffer back under the mark', () => {
    let buffers = seed({ seat_big: 'x'.repeat(STAGGER_HIGH_WATER_CHARS + 1) });
    let cursor = 0;

    // Bounded so a pacing bug fails the test rather than hanging it.
    for (let i = 0; i < 500 && buffers.seat_big.queue.length > STAGGER_HIGH_WATER_CHARS; i++) {
      const result = advance(buffers, ['seat_big'], cursor);
      buffers = result.buffers;
      cursor = result.cursor;
    }

    expect(buffers.seat_big.queue.length).toBeLessThanOrEqual(STAGGER_HIGH_WATER_CHARS);
  });
});

describe('completion, rule 4', () => {
  it('drains a finished seat at the accelerated rate, not instantly', () => {
    let buffers = seed({ seat_a: 'z'.repeat(500), seat_b: 'y'.repeat(500) });
    buffers = finishSeat(buffers, 'seat_a');

    // seat_a holds the slot this tick. Because it is finished it releases the
    // fast amount — the step must not snap straight to the end, and it must
    // not dawdle at the normal rate either.
    const result = advance(buffers, ['seat_a', 'seat_b'], 0);

    expect(result.buffers.seat_a.visible.length).toBe(FAST_RELEASE_CHARS);
    expect(result.buffers.seat_a.queue.length).toBeGreaterThan(0);

    // The unfinished seat holding the slot on the next tick releases the
    // normal amount, so the two rates are demonstrably different.
    const next = advance(result.buffers, ['seat_a', 'seat_b'], result.cursor);
    expect(next.buffers.seat_b.visible.length).toBe(RELEASE_CHARS);
  });

  it('marks a seat done even if no delta ever arrived', () => {
    const buffers = finishSeat({}, 'seat_a');

    expect(buffers.seat_a).toEqual({ visible: '', queue: '', done: true, activated: true });
  });
});

describe('force flush, rules 5 and 8', () => {
  it('empties every buffer immediately', () => {
    let buffers = seed({ seat_a: 'aaaaaa', seat_b: 'bbbbbb' });
    buffers = finishSeat(buffers, 'seat_b');

    const flushed = flushAllBuffers(buffers);

    expect(flushed.seat_a.visible).toBe('aaaaaa');
    expect(flushed.seat_a.queue).toBe('');
    expect(flushed.seat_b.visible).toBe('bbbbbb');
    expect(flushed.seat_b.queue).toBe('');
    expect(flushed.seat_b.done).toBe(true);
  });

  it('leaves a subsequent tick with nothing to do', () => {
    const flushed = flushAllBuffers(seed({ seat_a: 'aaaaaa' }));
    const result = advance(flushed, ['seat_a'], 0);

    expect(result.changed).toBe(false);
  });

  it('reports no active seats once everything has flushed and finished', () => {
    let buffers = seed({ seat_a: 'aaaaaa', seat_b: 'bbbbbb' });
    buffers = finishSeat(buffers, 'seat_a');
    buffers = finishSeat(buffers, 'seat_b');

    expect(activeSeatsFor(flushAllBuffers(buffers), ['seat_a', 'seat_b'])).toEqual([]);
  });
});

describe('active seats', () => {
  it('counts a seat as active while it holds text', () => {
    expect(isActiveBuffer('seat_a', seed({ seat_a: 'aa' }))).toBe(true);
  });

  it('stays active between draining and the server reporting done', () => {
    // The seat's text has all been shown, but its call has not returned. It is
    // still thinking, and the indicator must not blink out early.
    const drained = advance(seed({ seat_a: 'abc' }), ['seat_a'], 0).buffers;

    expect(drained.seat_a.queue).toBe('');
    expect(drained.seat_a.done).toBe(false);
    expect(isActiveBuffer('seat_a', drained)).toBe(true);

    // Once the server reports done, it stops being active.
    expect(isActiveBuffer('seat_a', finishSeat(drained, 'seat_a'))).toBe(false);
  });

  it('reports active seats in order_index order, not buffer order', () => {
    const buffers = seed({ seat_c: 'cc', seat_a: 'aa', seat_b: 'bb' });

    expect(activeSeatsFor(buffers, ['seat_a', 'seat_b', 'seat_c'])).toEqual([
      'seat_a',
      'seat_b',
      'seat_c',
    ]);
  });

  it('ignores a seat that was never touched', () => {
    expect(isActiveBuffer('seat_missing', {})).toBe(false);
  });
});

describe('zero cadence is a pass-through, rule 7', () => {
  it('treats cadence zero as pass-through even when disabled is unset', () => {
    // This is the reduced-motion path: the page passes cadenceMs 0 without
    // setting `disabled`. Buffering here would render no text at all.
    expect(isPassThrough(0, false)).toBe(true);
    expect(isPassThrough(-1, false)).toBe(true);
    expect(isPassThrough(45, true)).toBe(true);
    expect(isPassThrough(45, false)).toBe(false);
  });

  it('renders a delta immediately when paced through', () => {
    const buffers = receiveDelta({}, 'seat_a', 'hello', true);

    expect(buffers.seat_a.visible).toBe('hello');
    expect(buffers.seat_a.queue).toBe('');
    expect(buffers.seat_a.activated).toBe(true);
  });

  it('leaves nothing for a tick to release', () => {
    const buffers = receiveDelta({}, 'seat_a', 'hello', true);
    const result = advance(buffers, ['seat_a'], 0);

    expect(result.changed).toBe(false);
    expect(buffers.seat_a.visible).toBe('hello');
  });
});

describe('defaults', () => {
  it('ships a buffer shape with every field defined', () => {
    expect(emptyRevealBuffer()).toEqual({ visible: '', queue: '', done: false, activated: false });
  });

  it('uses the section 16.10 high-water mark and release rates', () => {
    expect(DEFAULT_ADVANCE_OPTIONS.highWaterChars).toBe(STAGGER_HIGH_WATER_CHARS);
    expect(DEFAULT_ADVANCE_OPTIONS.releaseChars).toBe(RELEASE_CHARS);
    expect(DEFAULT_ADVANCE_OPTIONS.fastReleaseChars).toBe(FAST_RELEASE_CHARS);
    expect(FAST_RELEASE_CHARS).toBeGreaterThan(RELEASE_CHARS);
  });
});
