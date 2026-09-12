import 'server-only';

import { AUTHOR_BRIEF_WORD_CAP, type ProfileItemKind, type ProfileItemSource } from '@/shared/constants';
import { kindOrder } from './merge';

/**
 * Deterministic summary rendering, section 10.5.
 *
 * **No LLM call.** Template plus items, and nothing else: the same profile must
 * always produce the same text, so the editor can show the user exactly what
 * the agents receive and the user can trust that text. Every function here is
 * pure and depends on nothing but its arguments — no clock, no randomness, no
 * I/O.
 *
 * Two renderings are produced (both stored on the `profiles` row):
 *
 *  - `summary_text` for the Me Agent: every `kind`, full detail, ordered by
 *    kind then `order_index`.
 *  - `author_brief` for the seven lens seats: `skill`, `constraint`,
 *    `anti_pattern` and `goal` items only, labels with one-line details, hard
 *    capped at {@link AUTHOR_BRIEF_WORD_CAP} words.
 */

/** The columns rendering reads. Structurally satisfied by `ProfileItemDTO` and `MergedProfileItem`. */
export interface SummaryItem {
  kind: ProfileItemKind;
  label: string;
  detail: string;
  source: ProfileItemSource;
  confidence: number;
  orderIndex: number;
  /** Hidden-by-default items are never rendered. */
  stale?: boolean;
  locked?: boolean;
}

/** Kinds the seven lens seats get, per section 10.5. */
export const AUTHOR_BRIEF_KINDS: readonly ProfileItemKind[] = [
  'skill',
  'constraint',
  'anti_pattern',
  'goal',
];

/** Shown when a profile has no renderable items, so a prompt never gets an empty block. */
export const EMPTY_PROFILE_TEXT = '_(No profile items yet.)_';

const KIND_HEADINGS: Record<ProfileItemKind, string> = {
  skill: 'Skills',
  project: 'Projects',
  taste: 'Taste',
  experience: 'Experience',
  constraint: 'Constraints',
  goal: 'Goals',
  anti_pattern: 'Anti-patterns',
};

/** One line of detail for the brief. Long detail is cut at a sentence boundary. */
const BRIEF_DETAIL_MAX_CHARS = 140;

/** Words reserved for the truncation notice, so the cap is never exceeded. */
const TRUNCATION_NOTICE_WORDS = 8;
const TRUNCATION_NOTICE = '_(brief truncated at the word cap)_';

/**
 * Non-stale items in render order: kind order from constants, then
 * `order_index`, then label as a stable tie-break.
 */
export function activeItems(items: readonly SummaryItem[]): SummaryItem[] {
  return items
    .filter((item) => !item.stale)
    .slice()
    .sort(
      (a, b) =>
        kindOrder(a.kind) - kindOrder(b.kind) ||
        a.orderIndex - b.orderIndex ||
        a.label.localeCompare(b.label),
    );
}

/** Whitespace-delimited word count, used to enforce the brief's hard cap. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * `summary_text` for the Me Agent: every kind, full detail (section 10.5).
 * Inferred items are marked, because the Me Agent should know which parts of
 * the profile are guesses rather than facts (section 7.3).
 */
export function renderSummaryText(items: readonly SummaryItem[]): string {
  const active = activeItems(items);
  if (active.length === 0) return EMPTY_PROFILE_TEXT;

  const blocks: string[] = [];
  for (const [kind, group] of groupByKind(active)) {
    const lines = [`## ${KIND_HEADINGS[kind]}`, ...group.map(renderSummaryLine)];
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function renderSummaryLine(item: SummaryItem): string {
  const detail = item.detail.trim().replace(/\s+/g, ' ');
  const detailPart = detail ? ` — ${detail}` : '';
  const marker = item.source === 'inferred' ? ` _(inferred, confidence ${item.confidence.toFixed(2)})_` : '';
  return `- **${item.label}**${marker}${detailPart}`;
}

/**
 * `author_brief` for the seven lens seats: the four kinds that actually change
 * what they propose, as labels with one-line details, hard-capped at
 * {@link AUTHOR_BRIEF_WORD_CAP} words (section 10.5).
 */
export function renderAuthorBrief(items: readonly SummaryItem[]): string {
  const active = activeItems(items).filter((item) => AUTHOR_BRIEF_KINDS.includes(item.kind));
  if (active.length === 0) return EMPTY_PROFILE_TEXT;

  const blocks: string[] = [];
  for (const [kind, group] of groupByKind(active)) {
    const lines = [KIND_HEADINGS[kind], ...group.map(renderBriefLine)];
    blocks.push(lines.join('\n'));
  }

  return capToWordLimit(blocks);
}

function renderBriefLine(item: SummaryItem): string {
  const detail = firstSentence(item.detail, BRIEF_DETAIL_MAX_CHARS);
  return detail ? `- ${item.label}: ${detail}` : `- ${item.label}`;
}

/**
 * Trim whole lines until the document fits the word cap, then add a notice. The
 * result is guaranteed to be at or under the cap — a lens prompt that quietly
 * overruns its budget is exactly the failure this guard exists to prevent.
 */
function capToWordLimit(blocks: readonly string[]): string {
  const full = blocks.join('\n\n');
  if (countWords(full) <= AUTHOR_BRIEF_WORD_CAP) return full;

  const bodyBudget = AUTHOR_BRIEF_WORD_CAP - TRUNCATION_NOTICE_WORDS;
  const kept: string[] = [];
  let used = 0;

  for (const block of blocks) {
    const next: string[] = [];
    for (const line of block.split('\n')) {
      const cost = countWords(line);
      if (used + cost > bodyBudget) {
        return `${[...kept, ...next].join('\n')}\n\n${TRUNCATION_NOTICE}`.trim();
      }
      next.push(line);
      used += cost;
    }
    kept.push(next.join('\n'));
  }

  return `${kept.join('\n\n')}\n\n${TRUNCATION_NOTICE}`;
}

/**
 * Both renderings at once, which is what the pipeline stores on the row. Same
 * items in, same two strings out.
 */
export function renderProfileViews(items: readonly SummaryItem[]): {
  summaryText: string;
  authorBrief: string;
  summaryWordCount: number;
  authorBriefWordCount: number;
} {
  const summaryText = renderSummaryText(items);
  const authorBrief = renderAuthorBrief(items);
  return {
    summaryText,
    authorBrief,
    summaryWordCount: countWords(summaryText),
    authorBriefWordCount: countWords(authorBrief),
  };
}

/** Group in canonical kind order, preserving the incoming order inside a kind. */
function groupByKind(items: readonly SummaryItem[]): Array<[ProfileItemKind, SummaryItem[]]> {
  const groups = new Map<ProfileItemKind, SummaryItem[]>();
  for (const item of items) {
    const group = groups.get(item.kind);
    if (group) group.push(item);
    else groups.set(item.kind, [item]);
  }
  return [...groups.entries()].sort((a, b) => kindOrder(a[0]) - kindOrder(b[0]));
}

/** First sentence of a detail, collapsed to one line and cut to `maxChars`. */
function firstSentence(detail: string, maxChars: number): string {
  const flat = detail.trim().replace(/\s+/g, ' ');
  if (!flat) return '';

  const stop = /[.!?](\s|$)/.exec(flat);
  const sentence = stop ? flat.slice(0, stop.index + 1) : flat;
  if (sentence.length <= maxChars) return sentence;

  const clipped = sentence.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
