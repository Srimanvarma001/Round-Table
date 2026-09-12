import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * `source_hash` for the profile pipeline, section 7.2.
 *
 * `profiles.source_hash` is a SHA-256 over the *raw* inputs the profile was
 * generated from. Keeping it here, in one tiny module, means the reader and the
 * writer of the hash can never drift: a profile is stale exactly when
 * `computeSourceHash(freshInputs) !== profile.sourceHash`.
 *
 * Nothing in this module throws — a hasher that can fail is a hasher that
 * breaks a page load for no reason.
 */

/** The parts hashed, one entry per ingestor. `null` means "source not run". */
export type SourceHashParts = Readonly<Record<string, string | number | boolean | null | undefined>>;

/**
 * Recursively sort object keys so two structurally identical payloads hash
 * identically regardless of key insertion order. Arrays keep their order
 * because order is meaningful for the inputs we hash (repo order, note chunks).
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: stable key order, so the same value always stringifies the same way. */
export function canonicalJson(value: unknown): string {
  try {
    return JSON.stringify(sortValue(value)) ?? '';
  } catch {
    // Circular or otherwise unserialisable: fall back to a marker rather than
    // throwing inside a hash. A marker that never matches is the safe default —
    // it makes the profile look stale, which is the conservative direction.
    return '"[unserialisable]"';
  }
}

/** SHA-256 of an arbitrary string or byte buffer, lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * SHA-256 over a set of named raw inputs (section 7.2). Parts are sorted by
 * name so callers cannot make an identical profile look stale by reordering
 * their arguments, and each part is length-prefixed so `{a:'xy',b:'z'}` can
 * never collide with `{a:'x',b:'yz'}`.
 */
export function computeSourceHash(parts: SourceHashParts): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => {
      const raw = parts[key];
      const value = raw === undefined ? null : raw;
      const text = typeof value === 'string' ? value : canonicalJson(value);
      return `${key}:${text.length}:${text}`;
    })
    .join('\n');

  return sha256Hex(canonical);
}

/** True when a stored hash matches a freshly computed one. Never throws. */
export function sourceHashMatches(
  stored: string | null | undefined,
  fresh: string | null | undefined,
): boolean {
  if (!stored || !fresh) return false;
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(fresh, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** First `length` characters of a hash, for logs and UI badges. */
export function shortHash(hash: string, length = 12): string {
  if (hash.length <= length) return hash;
  return hash.slice(0, length);
}

/** `''` when nothing was hashed, so an empty input is detectable. */
export function isEmptySourceHash(hash: string | null | undefined): boolean {
  return !hash || hash === computeSourceHash({});
}
