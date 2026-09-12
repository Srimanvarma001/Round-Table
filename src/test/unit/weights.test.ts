import { describe, expect, it } from 'vitest';

import {
  clampScore,
  collectDissent,
  compareByTieBreak,
  distinctness,
  isDissenter,
  jaccard,
  matchProposalByTitle,
  normaliseTitle,
  normaliseWeights,
  rankProposals,
  scoreProposal,
  tokenSet,
  WeightError,
  type TieBreakCandidate,
  type WeightableSeat,
} from '@/lib/agents/weights';
import { DEFAULT_LENS_WEIGHT, DEFAULT_ME_WEIGHT, SEAT_KEYS } from '@/shared/constants';

/** The seeded eight seats: one Me Agent at 0.25, seven lenses at 0.75/7. */
function defaultSeats(): WeightableSeat[] {
  return SEAT_KEYS.map((key, i) => ({
    id: key,
    weight: i === 0 ? DEFAULT_ME_WEIGHT : DEFAULT_LENS_WEIGHT,
    enabled: true,
  }));
}

describe('normaliseWeights', () => {
  it('sums the default eight seats to 1 with the Me Agent at exactly 0.25', () => {
    const n = normaliseWeights(defaultSeats());

    const total = Object.values(n).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(n[SEAT_KEYS[0]]).toBeCloseTo(0.25, 12);
    expect(Object.keys(n)).toHaveLength(8);
  });

  it('renormalises when a seat is disabled', () => {
    const seats = defaultSeats().map((s) =>
      s.id === 'seat_contrarian' ? { ...s, enabled: false } : s,
    );
    const n = normaliseWeights(seats);

    expect(n.seat_contrarian).toBe(0);
    // Disabling a lens pushes the Me Agent above its 0.25 share.
    expect(n[SEAT_KEYS[0]]).toBeGreaterThan(0.25);

    const enabledTotal = Object.entries(n)
      .filter(([id]) => id !== 'seat_contrarian')
      .reduce((s, [, w]) => s + w, 0);
    expect(enabledTotal).toBeCloseTo(1, 12);
  });

  it('renormalises when a seat is added', () => {
    const seats = [
      ...defaultSeats(),
      { id: 'ninth', weight: DEFAULT_LENS_WEIGHT, enabled: true },
    ];
    const n = normaliseWeights(seats);

    expect(Object.keys(n)).toHaveLength(9);
    expect(Object.values(n).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
    // The newcomer takes an equal lens share, so the Me Agent keeps 0.25 only
    // if the new total happens to work out — assert the invariant, not a
    // hard-coded number.
    expect(n.ninth).toBeCloseTo(n.seat_pragmatist, 12);
  });

  it('rejects a zero total weight with a typed error', () => {
    const seats = defaultSeats().map((s) => ({ ...s, weight: 0 }));

    expect(() => normaliseWeights(seats)).toThrow(WeightError);
    expect(() => normaliseWeights(seats)).toThrow(/zero/i);
  });

  it('rejects an empty enabled set with a typed error', () => {
    const seats = defaultSeats().map((s) => ({ ...s, enabled: false }));

    expect(() => normaliseWeights(seats)).toThrow(WeightError);
    expect(() => normaliseWeights(seats)).toThrow(/no enabled seats/i);
  });

  it('reports every seat, using zero rather than omission for disabled ones', () => {
    const seats = defaultSeats().map((s) =>
      s.id === 'seat_mentor' ? { ...s, enabled: false } : s,
    );
    const n = normaliseWeights(seats);

    expect(Object.keys(n).sort()).toEqual([...SEAT_KEYS].sort());
    expect(n.seat_mentor).toBe(0);
  });
});

describe('scoreProposal', () => {
  it('matches a hand-computed weighted score', () => {
    const seats = defaultSeats();
    const normalised = normaliseWeights(seats);

    // Me Agent 10, every lens 6 → 10×0.25 + 6×0.75 = 2.5 + 4.5 = 7.0
    const votes = seats.map((s) => ({
      agentId: s.id,
      score: s.id === SEAT_KEYS[0] ? 10 : 6,
    }));

    const result = scoreProposal(votes, normalised);

    expect(result.finalScore).toBeCloseTo(7, 10);
    expect(result.meanScore).toBeCloseTo(6.5, 10);
    expect(result.voteCount).toBe(8);
    expect(result.perSeat).toHaveLength(8);
  });

  it('lets a zero-weight seat score anything without changing the outcome', () => {
    const seats = defaultSeats();
    const normalised = normaliseWeights(seats);
    const honest = seats.map((s) => ({ agentId: s.id, score: 5 }));
    const baseline = scoreProposal(honest, normalised);

    const withGhost = [...honest, { agentId: 'disabled-seat', score: 10 }];
    const ghosted = scoreProposal(withGhost, { ...normalised, 'disabled-seat': 0 });

    expect(ghosted.finalScore).toBeCloseTo(baseline.finalScore, 12);
    expect(ghosted.perSeat.find((p) => p.agentId === 'disabled-seat')?.weighted).toBe(0);
  });

  it('does not let one provider dominate when it holds more seats', () => {
    // Every seat runs on GLM now, but the invariant is unchanged: the
    // weighting is per seat, never per provider.
    const seats = defaultSeats();
    const normalised = normaliseWeights(seats);

    const allSix = seats.map((s) => ({ agentId: s.id, score: 6 }));
    const uniform = scoreProposal(allSix, normalised);

    // Raising every vote by one raises the final score by exactly one,
    // whatever the seat-to-provider split happens to be.
    const allSeven = seats.map((s) => ({ agentId: s.id, score: 7 }));
    const raised = scoreProposal(allSeven, normalised);

    expect(raised.finalScore - uniform.finalScore).toBeCloseTo(1, 10);
  });

  it('ignores a vote from an unknown seat', () => {
    const normalised = normaliseWeights(defaultSeats());
    const result = scoreProposal(
      [
        { agentId: SEAT_KEYS[0], score: 8 },
        { agentId: 'seat-that-does-not-exist', score: 10 },
      ],
      normalised,
    );

    expect(result.voteCount).toBe(1);
    expect(result.finalScore).toBeCloseTo(8 * 0.25, 10);
  });

  it('clamps out-of-range and non-finite scores', () => {
    expect(clampScore(0)).toBe(1);
    expect(clampScore(11)).toBe(10);
    expect(clampScore(Number.NaN)).toBe(1);
    expect(clampScore(7.4)).toBe(7);
    expect(clampScore(7.5)).toBe(8);

    const normalised = normaliseWeights(defaultSeats());
    const result = scoreProposal([{ agentId: SEAT_KEYS[0], score: 99 }], normalised);
    expect(result.finalScore).toBeCloseTo(10 * 0.25, 10);
  });
});

describe('tie-break, section 12.3', () => {
  /** A candidate with every rule neutral, so each test varies exactly one. */
  function candidate(over: Partial<TieBreakCandidate> & { proposalId: string }): TieBreakCandidate {
    return {
      finalScore: 5,
      meanScore: 5,
      contrarianScore: 5,
      meScore: 5,
      createdAt: 1000,
      ...over,
    };
  }

  it('rule 1: the Me Agent score breaks a tie alone', () => {
    const a = candidate({ proposalId: 'a', meScore: 9 });
    const b = candidate({ proposalId: 'b', meScore: 7 });

    expect(compareByTieBreak(a, b)).toBeLessThan(0);
    expect(compareByTieBreak(b, a)).toBeGreaterThan(0);
  });

  it('rule 2: the unweighted mean breaks a tie once the Me Agent is level', () => {
    const a = candidate({ proposalId: 'a', meScore: 6, meanScore: 7.5 });
    const b = candidate({ proposalId: 'b', meScore: 6, meanScore: 6.5 });

    expect(compareByTieBreak(a, b)).toBeLessThan(0);
  });

  it('rule 3: the Contrarian score breaks a tie once the mean is level', () => {
    const a = candidate({ proposalId: 'a', contrarianScore: 4 });
    const b = candidate({ proposalId: 'b', contrarianScore: 8 });

    expect(compareByTieBreak(a, b)).toBeGreaterThan(0);
  });

  it('rule 4: the earlier proposal wins once everything scored is level', () => {
    const early = candidate({ proposalId: 'z', createdAt: 500 });
    const late = candidate({ proposalId: 'a', createdAt: 900 });

    // Note the ids are deliberately inverted: rule 4 must decide before rule 5.
    expect(compareByTieBreak(early, late)).toBeLessThan(0);
  });

  it('rule 5: a fully tied fixture resolves by id, ascending', () => {
    const a = candidate({ proposalId: 'aaa' });
    const b = candidate({ proposalId: 'bbb' });

    expect(compareByTieBreak(a, b)).toBeLessThan(0);
    expect(compareByTieBreak(b, a)).toBeGreaterThan(0);
    expect(compareByTieBreak(a, a)).toBe(0);

    expect(rankProposals([b, a]).map((c) => c.proposalId)).toEqual(['aaa', 'bbb']);
  });

  it('treats a missing Contrarian or Me Agent vote as the floor, not as a win', () => {
    const withMe = candidate({ proposalId: 'a', meScore: 5 });
    const withoutMe = candidate({ proposalId: 'b', meScore: null });

    expect(compareByTieBreak(withMe, withoutMe)).toBeLessThan(0);

    const withContrarian = candidate({ proposalId: 'a', contrarianScore: 1 });
    const withoutContrarian = candidate({ proposalId: 'b', contrarianScore: null });
    expect(compareByTieBreak(withContrarian, withoutContrarian)).toBeLessThan(0);
  });

  it('is a total order, so sorting is deterministic', () => {
    const fixture = [
      candidate({ proposalId: 'd', meScore: 7, meanScore: 6, createdAt: 400 }),
      candidate({ proposalId: 'b', meScore: 9, meanScore: 4, createdAt: 100 }),
      candidate({ proposalId: 'a', meScore: 9, meanScore: 8, createdAt: 900 }),
      candidate({ proposalId: 'c', meScore: 9, meanScore: 8, createdAt: 200 }),
    ];

    const once = rankProposals(fixture).map((c) => c.proposalId);
    const twice = rankProposals([...fixture].reverse()).map((c) => c.proposalId);

    expect(once).toEqual(twice);
    // Me Agent descending first: a, b and c all at 9 beat d at 7. Of those,
    // mean 8 (a, c) beats mean 4 (b), and a and c are level through rule 3,
    // so rule 4 gives it to the earlier idea — c, created at 200, not a at 900.
    expect(once).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('dissent, section 12.4', () => {
  const isWinning = true;

  it('fires at exactly mean minus two, and not one point above it', () => {
    // [7, 10, 10] → mean 9, mean − 2 = 7. A score of 7 is a dissent.
    const atBoundary = [
      { agentId: 'a', score: 7 },
      { agentId: 'b', score: 10 },
      { agentId: 'c', score: 10 },
    ];
    expect(isDissenter(atBoundary[0], atBoundary, false)).toBe(true);

    // [8, 10, 10] → mean 9.333, mean − 2 = 7.333. A score of 8 is not.
    const justAbove = [
      { agentId: 'a', score: 8 },
      { agentId: 'b', score: 10 },
      { agentId: 'c', score: 10 },
    ];
    expect(isDissenter(justAbove[0], justAbove, false)).toBe(false);
  });

  it('fires on a score of exactly 5 for the winning proposal, and not at 5 upward', () => {
    const clustered = [
      { agentId: 'a', score: 5 },
      { agentId: 'b', score: 8 },
      { agentId: 'c', score: 8 },
    ];
    // mean 7, mean − 2 = 5 → the mean rule catches 5 first, but the floor rule
    // must agree rather than contradict it.
    expect(isDissenter(clustered[0], clustered, isWinning)).toBe(true);

    // [4, 6, 6] → mean 5.333, mean − 2 = 3.333. A score of 4 clears the mean
    // rule, so only the winner-floor rule can catch it.
    const winnerFloor = [
      { agentId: 'a', score: 4 },
      { agentId: 'b', score: 6 },
      { agentId: 'c', score: 6 },
    ];
    expect(isDissenter(winnerFloor[0], winnerFloor, isWinning)).toBe(true);
    expect(isDissenter(winnerFloor[0], winnerFloor, false)).toBe(false);

    // The floor is strictly below 5: a score of 5 sits exactly on it and is
    // not a dissent, while a score of 4 is. [5, 6, 6] keeps the mean rule out
    // of the way (mean 5.667, mean − 2 = 3.667) so the floor alone decides.
    const atFloor = [
      { agentId: 'a', score: 5 },
      { agentId: 'b', score: 6 },
      { agentId: 'c', score: 6 },
    ];
    expect(isDissenter(atFloor[0], atFloor, isWinning)).toBe(false);
    expect(isDissenter({ agentId: 'a', score: 4 }, atFloor, isWinning)).toBe(true);
  });

  it('collects every dissenter and nothing else', () => {
    const votes = [
      { agentId: 'me', score: 9 },
      { agentId: 'pragmatist', score: 9 },
      { agentId: 'wildcard', score: 3 },
      { agentId: 'contrarian', score: 4 },
    ];

    const dissent = collectDissent(votes, true).map((v) => v.agentId);
    expect(dissent).toEqual(['wildcard', 'contrarian']);
  });

  it('returns false for an empty vote set rather than dividing by zero', () => {
    expect(isDissenter({ agentId: 'a', score: 1 }, [], false)).toBe(false);
  });
});

describe('similarity metrics', () => {
  it('scores identical token sets as 1 and disjoint ones as 0', () => {
    expect(jaccard('solar powered drone', 'solar powered drone')).toBe(1);
    expect(jaccard('solar powered drone', 'midnight library archive')).toBe(0);
  });

  it('ignores stop words and short tokens', () => {
    expect(tokenSet('a solar powered drone for the market')).toEqual(
      new Set(['solar', 'powered', 'drone', 'market']),
    );
  });

  it('reports zero distinctness below two documents', () => {
    expect(distinctness([])).toBe(0);
    expect(distinctness([{ title: 'a', description: 'b' }])).toBe(0);
  });

  it('reports higher distinctness for unrelated proposals than for near-copies', () => {
    const clones = distinctness([
      { title: 'Solar drone delivery', description: 'Delivers parcels by drone' },
      { title: 'Solar drone delivery network', description: 'Delivers parcels by drone' },
    ]);
    const different = distinctness([
      { title: 'Solar drone delivery', description: 'Delivers parcels by drone' },
      { title: 'Midnight library archive', description: 'Archives local oral history' },
    ]);

    expect(clones).toBeGreaterThan(different);
  });
});

describe('title matching, appendix A.2', () => {
  const proposals = [
    { id: 'p1', title: 'Rooftop Solar Cooperative' },
    { id: 'p2', title: 'Midnight Library Network' },
    { id: 'p3', title: 'Cold Chain Micro-Hubs' },
  ];

  it('normalises case and punctuation', () => {
    expect(normaliseTitle('  Rooftop   Solar, Cooperative! ')).toBe('rooftop solar cooperative');
    expect(matchProposalByTitle(proposals, 'rooftop solar cooperative')?.id).toBe('p1');
  });

  it('resolves an exact match before a near one', () => {
    expect(matchProposalByTitle(proposals, 'Midnight Library Network')?.id).toBe('p2');
  });

  it('resolves a unique containment match', () => {
    expect(matchProposalByTitle(proposals, 'Midnight Library')?.id).toBe('p2');
  });

  it('returns null rather than guessing when nothing is close', () => {
    expect(matchProposalByTitle(proposals, 'Underwater basket weaving')).toBeNull();
    expect(matchProposalByTitle(proposals, '')).toBeNull();
  });
});
