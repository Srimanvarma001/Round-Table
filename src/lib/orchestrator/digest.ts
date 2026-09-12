/**
 * Artefact compression for later steps, sections 11.3 and 17.
 *
 * By the vote step a run holds up to sixteen proposals, up to twenty-four
 * critiques and eight vote blocks. Pasting all of it into every prompt is how
 * a run costs three dollars instead of thirty cents, and it also *hurts*
 * quality: the model spends its attention on material it has already seen.
 *
 * Every function here is:
 *
 *  - **deterministic** — same input, same output. No clock, no randomness, no
 *    iteration over a `Set` whose order depends on insertion history. The
 *    replay and export views (sections 18.2, 18.3) depend on this.
 *  - **budgeted** — a token budget is passed in, never inferred.
 *  - **leader-preserving** — the leading item is never dropped. When the
 *    budget is tight the *lowest*-ranked items are dropped first and the top
 *    item is degraded in place (full → body trimmed → heading only → hard
 *    truncation) rather than removed. A prompt that omits the front-runner is
 *    worse than useless.
 */

/** Section 8.3 rule 2 / section 17.2: characters over four, rounded up. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Cut at a word boundary so a truncated line never ends mid-token. */
export function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  // Only honour the word boundary if it does not throw away most of the room
  // we were given; a single 400-character word would otherwise truncate to
  // nothing.
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  return truncateToChars(text, maxTokens * 4);
}

// ---------------------------------------------------------------------------
// Digest rendering
// ---------------------------------------------------------------------------

export interface DigestItem {
  /** Stable identity; only used for the report and the deterministic tie-break. */
  id: string;
  /** The line that identifies the item. Kept longest. */
  heading: string;
  /** The detail that may be trimmed. */
  body: string;
  /** Optional extras, dropped before the body is trimmed. */
  notes?: readonly string[];
  /** Lower is better. `renderDigest` always renders the lowest rank first. */
  rank: number;
}

export interface DigestOptions {
  /** Characters of body kept at the "compact" degradation level. */
  compactChars?: number;
  /** Prefix per item, e.g. `'1. '` or `'- '`. Must be deterministic. */
  bullet?: (index: number) => string;
}

export interface DigestResult {
  text: string;
  includedIds: string[];
  droppedIds: string[];
  /** Items rendered below their full form. */
  degraded: number;
  tokensUsed: number;
}

const DEGRADATION_LEVELS = 3; // full, compact, heading-only

function renderAtLevel(
  item: DigestItem,
  level: number,
  bullet: string,
  compactChars: number,
): string {
  const notes = item.notes && item.notes.length > 0 ? `\n${item.notes.join('\n')}` : '';
  switch (level) {
    case 0:
      return `${bullet}${item.heading}\n${item.body}${notes}`;
    case 1:
      return `${bullet}${item.heading}\n${truncateToChars(item.body, compactChars)}`;
    default:
      return `${bullet}${item.heading}`;
  }
}

/**
 * Deterministic ordering: rank, then id. `Array.prototype.sort` is stable in
 * V8, but relying on stability across engines is not a determinism guarantee,
 * so the id is an explicit tiebreak.
 */
function orderItems(items: readonly DigestItem[]): DigestItem[] {
  return [...items].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Render items into a numbered/appendable block that fits `budgetTokens`.
 *
 * The first item after ordering is the leader and is guaranteed to appear,
 * even if the budget cannot hold its heading — in that case it is hard-cut to
 * the budget rather than dropped.
 */
export function renderDigest(
  items: readonly DigestItem[],
  budgetTokens: number,
  options: DigestOptions = {},
): DigestResult {
  const compactChars = options.compactChars ?? 240;
  const bulletFor = options.bullet ?? ((index: number) => `${index + 1}. `);

  const ordered = orderItems(items);
  const chunks: string[] = [];
  const includedIds: string[] = [];
  const droppedIds: string[] = [];
  let tokensUsed = 0;
  let degraded = 0;

  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i];
    const bullet = bulletFor(i);
    const isLeader = chunks.length === 0;

    let rendered: string | null = null;
    let levelUsed = 0;

    for (let level = 0; level < DEGRADATION_LEVELS; level++) {
      const candidate = renderAtLevel(item, level, bullet, compactChars);
      const cost = estimateTokens(candidate);
      if (tokensUsed + cost <= budgetTokens) {
        rendered = candidate;
        levelUsed = level;
        break;
      }
    }

    if (rendered === null) {
      if (isLeader) {
        // The leader is retained unconditionally, so an absurdly small budget
        // costs the leader its length rather than its place in the prompt.
        rendered = truncateToTokens(renderAtLevel(item, 0, bullet, compactChars), Math.max(1, budgetTokens));
        levelUsed = DEGRADATION_LEVELS - 1;
      } else {
        // Best-first ordering means everything after this is lower ranked, so
        // continuing would only ever add more items that also do not fit.
        for (const rest of ordered.slice(i)) droppedIds.push(rest.id);
        break;
      }
    }

    chunks.push(rendered);
    includedIds.push(item.id);
    tokensUsed += estimateTokens(rendered);
    if (levelUsed > 0) degraded += 1;
  }

  return {
    text: chunks.join('\n'),
    includedIds,
    droppedIds,
    degraded,
    tokensUsed,
  };
}

// ---------------------------------------------------------------------------
// Domain-agnostic line renderers
// ---------------------------------------------------------------------------

export interface CritiqueLine {
  stance: string;
  seatName: string;
  comment: string;
}

/**
 * A one-line-per-critique block, used by the refine and vote step contexts.
 * Critique comments are bounded by their own 90-word instruction, so this is a
 * simple join rather than a second digest.
 */
export function renderCritiqueLines(
  critiques: readonly CritiqueLine[],
  budgetTokens: number,
): DigestResult {
  const items: DigestItem[] = critiques.map((critique, index) => ({
    id: `critique-${index}`,
    heading: `[${critique.stance}] ${critique.seatName}`,
    body: critique.comment,
    rank: index,
  }));

  return renderDigest(items, budgetTokens, {
    compactChars: 180,
    bullet: () => '- ',
  });
}

export interface ScoreLine {
  seatName: string;
  score: number;
  comment?: string;
}

/** `Pragmatist 7, Wildcard 9, …` — the reveal prompt's score pattern. */
export function renderScorePattern(scores: readonly ScoreLine[]): string {
  if (scores.length === 0) return 'no votes were cast';
  return scores.map((s) => `${s.seatName} ${s.score}`).join(', ');
}
