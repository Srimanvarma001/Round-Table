import 'server-only';

import { randomUUID } from 'node:crypto';

import type { ProfileItemKind, ProfileItemSource } from '@/shared/constants';
import type { ProfileDiff } from '@/shared/types';

/**
 * The merge rule, section 10.4.
 *
 * This is the safety-critical module of the profile pipeline, because it is
 * where a regeneration could destroy the user's work. The rule is:
 *
 * 1. Items with `source = 'manual'` or `locked = 1` are copied through
 *    **untouched**. This is the guarantee that makes regeneration safe: a user
 *    who corrects a machine guess and locks it never sees that correction
 *    overwritten.
 * 2. Generated items are matched against existing generated items by `kind`
 *    plus a **normalised label**. A match is updated in place and keeps its
 *    `order_index`, so the profile does not reshuffle itself on every run.
 * 3. Unmatched generated items are inserted; generated items absent from the
 *    new extraction are marked `stale` — hidden by default behind a "show
 *    removed" toggle. Nothing is ever silently deleted.
 * 4. The result is written as a new `profiles` row at `version + 1`; the old
 *    row becomes `archived`. Activation is a separate, explicit step, which is
 *    why nothing here touches the database: this module is pure so the diff can
 *    be shown to the user before anything is written.
 *
 * The module is pure and deterministic apart from the ids it mints for new
 * items, so the editor can run it against an unsaved draft and show the delta.
 */

/** The columns the merge rule reads. Structurally satisfied by `ProfileItemRow` and `ProfileItemDTO`. */
export interface ProfileItemLike {
  id: string;
  kind: ProfileItemKind;
  label: string;
  detail: string;
  source: ProfileItemSource;
  confidence: number;
  locked: boolean;
  stale: boolean;
  orderIndex: number;
}

/** An item fresh out of `extract.ts`. It has no id, order or lifecycle yet. */
export interface ExtractedItemLike {
  kind: ProfileItemKind;
  label: string;
  detail: string;
  source: ProfileItemSource;
  confidence: number;
}

export interface MergedProfileItem extends ProfileItemLike {
  /** True when the row does not exist yet and must be inserted. */
  isNew: boolean;
  /** True when an existing row's detail or confidence changed. */
  changed: boolean;
}

export interface MergeResult {
  /** The complete item set for the next profile version. */
  items: MergedProfileItem[];
  /** Items inserted because nothing matched them. */
  added: number;
  /** Existing generated items updated in place. */
  updated: number;
  /** Existing generated items whose content did not change. */
  unchanged: number;
  /** Generated items that disappeared from the extraction and are now hidden. */
  staled: number;
  /** Manual or locked items copied through untouched (section 10.4 rule 1). */
  preserved: number;
  /** Extraction items dropped because a manual or locked item already covers them. */
  skippedAgainstPreserved: number;
  warnings: string[];
}

/** A manual or locked item is never touched by generation (section 10.4 rule 1). */
export function isPreserved(item: Pick<ProfileItemLike, 'source' | 'locked'>): boolean {
  return item.source === 'manual' || item.locked === true;
}

/**
 * Normalise a label for matching: lowercase, trimmed, punctuation and spacing
 * collapsed. `"TypeScript"`, `"typescript "` and `"Type-Script"` are one item.
 */
export function normaliseLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The match key from section 10.4 rule 2: kind plus normalised label. */
export function itemKey(kind: ProfileItemKind, label: string): string {
  return `${kind}::${normaliseLabel(label)}`;
}

/**
 * Combine a fresh extraction with the existing profile. Pure; no database, no
 * clock, no LLM. Section 10.4.
 */
export function mergeProfile(
  existing: readonly ProfileItemLike[],
  extracted: readonly ExtractedItemLike[],
): MergeResult {
  const warnings: string[] = [];

  // --- rule 1: preserve manual and locked items exactly as they are ---------
  const preservedById = new Map<string, MergedProfileItem>();
  const generated: ProfileItemLike[] = [];
  for (const item of existing) {
    if (isPreserved(item)) {
      preservedById.set(item.id, { ...item, isNew: false, changed: false });
    } else {
      generated.push(item);
    }
  }

  const preservedKeys = new Set(
    [...preservedById.values()].map((item) => itemKey(item.kind, item.label)),
  );

  // --- rule 2: match generated items by kind + normalised label -------------
  const generatedByKey = new Map<string, ProfileItemLike>();
  for (const item of generated) {
    const key = itemKey(item.kind, item.label);
    if (!generatedByKey.has(key)) generatedByKey.set(key, item);
  }

  const nextOrderByKind = nextOrderIndexes([...existing]);
  const merged: MergedProfileItem[] = [];
  const matchedExistingIds = new Set<string>();
  const seenExtractedKeys = new Set<string>();
  let skippedAgainstPreserved = 0;

  for (const candidate of extracted) {
    const key = itemKey(candidate.kind, candidate.label);

    // Duplicate keys inside one extraction: keep the first, ignore the rest.
    if (seenExtractedKeys.has(key)) continue;
    seenExtractedKeys.add(key);

    // A manual or locked item already says this. Generation must not shadow it,
    // and must not create a second row with the same label either.
    if (preservedKeys.has(key)) {
      skippedAgainstPreserved += 1;
      continue;
    }

    const match = generatedByKey.get(key);
    if (match) {
      matchedExistingIds.add(match.id);
      const changed = match.detail !== candidate.detail || match.confidence !== candidate.confidence;
      merged.push({
        ...match,
        // The existing label wins: the user may have let the model's casing in
        // once and it should not flip back on the next run.
        label: match.label,
        detail: candidate.detail,
        confidence: candidate.confidence,
        source: candidate.source,
        stale: false,
        isNew: false,
        changed,
      });
      continue;
    }

    // --- rule 3: unmatched generated items are inserted --------------------
    merged.push({
      id: randomUUID(),
      kind: candidate.kind,
      label: candidate.label,
      detail: candidate.detail,
      source: candidate.source,
      confidence: candidate.confidence,
      locked: false,
      stale: false,
      orderIndex: allocateOrder(nextOrderByKind, candidate.kind),
      isNew: true,
      changed: false,
    });
  }

  // --- rule 3: generated items that vanished are hidden, never deleted -----
  let staled = 0;
  for (const item of generated) {
    if (matchedExistingIds.has(item.id)) continue;
    if (item.stale) {
      // Already hidden: keep it exactly as it was rather than restamping it.
      merged.push({ ...item, isNew: false, changed: false });
      continue;
    }
    staled += 1;
    merged.push({ ...item, stale: true, isNew: false, changed: false });
  }

  merged.push(...preservedById.values());

  const items = sortItems(merged);
  const added = items.filter((item) => item.isNew).length;
  const updated = items.filter((item) => !item.isNew && item.changed).length;
  // Stale items are neither updated nor "unchanged" from the user's point of
  // view: they are hidden, and counted separately as `staled`.
  const unchanged = items.filter((item) => !item.isNew && !item.changed && !item.stale).length;

  if (skippedAgainstPreserved > 0) {
    warnings.push(
      `${skippedAgainstPreserved} generated item(s) were skipped because a manual or locked item already covers them.`,
    );
  }
  if (staled > 0) {
    warnings.push(`${staled} item(s) were removed from the new profile; they are hidden, not deleted.`);
  }

  return {
    items,
    added,
    updated,
    unchanged,
    staled,
    preserved: preservedById.size,
    skippedAgainstPreserved,
    warnings,
  };
}

/**
 * `order_index` per kind, one past the highest existing value, so new items are
 * appended within their kind instead of colliding with what is already there.
 */
function nextOrderIndexes(items: readonly ProfileItemLike[]): Map<ProfileItemKind, number> {
  const map = new Map<ProfileItemKind, number>();
  for (const item of items) {
    const current = map.get(item.kind);
    const next = item.orderIndex + 1;
    if (current === undefined || next > current) map.set(item.kind, next);
  }
  return map;
}

function allocateOrder(map: Map<ProfileItemKind, number>, kind: ProfileItemKind): number {
  const next = map.get(kind) ?? 0;
  map.set(kind, next + 1);
  return next;
}

/**
 * Display order: kind order from constants, then `order_index`, then label.
 * Sorting here means the returned array is already in the order the editor and
 * `summary.ts` will render.
 */
function sortItems(items: readonly MergedProfileItem[]): MergedProfileItem[] {
  return [...items].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.orderIndex - b.orderIndex ||
      a.label.localeCompare(b.label),
  );
}

/** Canonical kind order, from `PROFILE_ITEM_KINDS` (section 7.3). */
const KIND_ORDER: readonly ProfileItemKind[] = [
  'skill',
  'project',
  'taste',
  'experience',
  'constraint',
  'goal',
  'anti_pattern',
];

/** Canonical kind order, exported so `summary.ts` and the editor share it. */
export function kindOrder(kind: ProfileItemKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/**
 * The diff preview the editor shows before writing (sections 10.4 rule 4 and
 * 10.6): what would be added, what would change, what would disappear.
 *
 * `before` is the current profile's items, `after` is the merged draft. Stale
 * items count as gone in both directions, so an item that was already hidden
 * does not show up as "removed" a second time.
 */
export function computeProfileDiff(
  before: readonly ProfileItemLike[],
  after: readonly ProfileItemLike[],
): ProfileDiff {
  const beforeActive = new Map<string, ProfileItemLike>();
  for (const item of before) {
    if (item.stale) continue;
    const key = itemKey(item.kind, item.label);
    if (!beforeActive.has(key)) beforeActive.set(key, item);
  }

  const afterActive = new Map<string, ProfileItemLike>();
  for (const item of after) {
    if (item.stale) continue;
    const key = itemKey(item.kind, item.label);
    if (!afterActive.has(key)) afterActive.set(key, item);
  }

  const added: ProfileDiff['added'] = [];
  const changed: ProfileDiff['changed'] = [];
  let preserved = 0;

  for (const [key, item] of afterActive) {
    if (isPreserved(item)) preserved += 1;

    const previous = beforeActive.get(key);
    if (!previous) {
      added.push({ kind: item.kind, label: item.label, source: item.source });
      continue;
    }
    if (previous.detail !== item.detail) {
      // `from`/`to` carry the detail text: it is the part of an item that
      // actually changes, and it is what the diff pane renders side by side.
      changed.push({ label: item.label, from: previous.detail, to: item.detail });
    }
  }

  const removed: ProfileDiff['removed'] = [];
  for (const [key, item] of beforeActive) {
    if (!afterActive.has(key)) removed.push({ kind: item.kind, label: item.label });
  }

  const byLabel = (a: { label: string }, b: { label: string }): number => a.label.localeCompare(b.label);

  return {
    added: added.sort(byLabel),
    changed: changed.sort(byLabel),
    removed: removed.sort(byLabel),
    preserved,
  };
}

/** Convenience for a store that needs the raw match key of a stored row. */
export function keyOf(item: Pick<ProfileItemLike, 'kind' | 'label'>): string {
  return itemKey(item.kind, item.label);
}
