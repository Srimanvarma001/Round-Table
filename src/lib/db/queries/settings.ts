import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { DEFAULT_AVATAR_STYLE, DEFAULT_TEMPERATURE_BY_SEAT_CLASS } from '@/lib/agents/defaults';
import { config, nowMs, type Db } from '@/lib/db/client';
import { settings, type SettingRow } from '@/lib/db/schema';
import {
  AVATAR_STYLES,
  DEFAULT_CONCURRENCY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_STAGGER_CADENCE_MS,
  DEFAULT_THEME,
  MAX_CRITIQUES_PER_AGENT,
  THEMES,
} from '@/shared/constants';
import type { SettingsDTO } from '@/shared/types';

/**
 * Key/value settings, section 7.11 and section 6.2.
 *
 * One row per field, with `key` the field name of `SettingsDTO` and `value` the
 * JSON encoding. Secrets never enter this table: section 6.2 is explicit that
 * the settings page reports key *presence* from `config` and never a value.
 *
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNum(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function positiveNum(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function oneOf<T extends string>(allowed: readonly T[]) {
  return (value: unknown): T | undefined =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : undefined;
}

function temperatureBySeatClass(
  value: unknown,
): SettingsDTO['temperatureBySeatClass'] | undefined {
  if (!isRecord(value)) return undefined;
  const me = num(value.me);
  const lens = num(value.lens);
  if (me === undefined || lens === undefined) return undefined;
  return { me, lens };
}

/**
 * One validator per field, typed so a new `SettingsDTO` field without a
 * validator is a compile error rather than a silently unreadable setting.
 */
type FieldCoercers = {
  [K in keyof SettingsDTO]: (value: unknown) => SettingsDTO[K] | undefined;
};

const COERCERS: FieldCoercers = {
  theme: oneOf(THEMES),
  budgetUsd: positiveNum,
  maxTokens: positiveNum,
  maxCalls: positiveNum,
  staggerCadenceMs: nonNegativeNum,
  refineEnabled: bool,
  maxCritiquesPerAgent: nonNegativeNum,
  reasoningPanelEnabled: bool,
  defaultAvatarStyle: oneOf(AVATAR_STYLES),
  temperatureBySeatClass,
  requestTimeoutMs: positiveNum,
  retries: nonNegativeNum,
  concurrency: positiveNum,
};

/** Field names, for iteration and for the settings form. */
export const SETTINGS_KEYS = Object.keys(COERCERS) as (keyof SettingsDTO)[];

/**
 * Coerce stored key/value rows into a settings patch. A row with the wrong
 * shape (hand-edited database, a setting written by an older build) is dropped
 * rather than allowed to poison the whole settings object. The switch is
 * explicit so each assignment is checked against `SettingsDTO`.
 */
function coerceSettings(
  entries: Iterable<{ key: string; value: unknown }>,
): Partial<SettingsDTO> {
  const patch: Partial<SettingsDTO> = {};

  for (const { key, value } of entries) {
    switch (key) {
      case 'theme':
        patch.theme = COERCERS.theme(value);
        break;
      case 'budgetUsd':
        patch.budgetUsd = COERCERS.budgetUsd(value);
        break;
      case 'maxTokens':
        patch.maxTokens = COERCERS.maxTokens(value);
        break;
      case 'maxCalls':
        patch.maxCalls = COERCERS.maxCalls(value);
        break;
      case 'staggerCadenceMs':
        patch.staggerCadenceMs = COERCERS.staggerCadenceMs(value);
        break;
      case 'refineEnabled':
        patch.refineEnabled = COERCERS.refineEnabled(value);
        break;
      case 'maxCritiquesPerAgent':
        patch.maxCritiquesPerAgent = COERCERS.maxCritiquesPerAgent(value);
        break;
      case 'reasoningPanelEnabled':
        patch.reasoningPanelEnabled = COERCERS.reasoningPanelEnabled(value);
        break;
      case 'defaultAvatarStyle':
        patch.defaultAvatarStyle = COERCERS.defaultAvatarStyle(value);
        break;
      case 'temperatureBySeatClass':
        patch.temperatureBySeatClass = COERCERS.temperatureBySeatClass(value);
        break;
      case 'requestTimeoutMs':
        patch.requestTimeoutMs = COERCERS.requestTimeoutMs(value);
        break;
      case 'retries':
        patch.retries = COERCERS.retries(value);
        break;
      case 'concurrency':
        patch.concurrency = COERCERS.concurrency(value);
        break;
      default:
        break; // unknown key: ignored, never deleted
    }
  }

  // A row that coerces to undefined is malformed (hand-edited database, older
  // build) and is dropped here, so Object.assign in getSettingsOrDefaults can
  // never overwrite a default with undefined.
  for (const key of Object.keys(patch) as (keyof SettingsDTO)[]) {
    if (patch[key] === undefined) delete patch[key];
  }

  return patch;
}

/** Section 6.2 defaults: budgets from the environment, the rest from constants. */
export function settingsDefaults(): SettingsDTO {
  return {
    theme: DEFAULT_THEME,
    budgetUsd: config.RUN_BUDGET_USD,
    maxTokens: config.RUN_MAX_TOKENS,
    maxCalls: config.RUN_MAX_CALLS,
    staggerCadenceMs: DEFAULT_STAGGER_CADENCE_MS,
    refineEnabled: true,
    maxCritiquesPerAgent: MAX_CRITIQUES_PER_AGENT,
    reasoningPanelEnabled: true,
    defaultAvatarStyle: DEFAULT_AVATAR_STYLE,
    temperatureBySeatClass: {
      me: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.me,
      lens: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    },
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    concurrency: DEFAULT_CONCURRENCY,
  };
}

// ---------------------------------------------------------------------------
// Raw key/value access
// ---------------------------------------------------------------------------

/** The stored JSON value for a key, or undefined when the key is absent. */
export function getSetting<T = unknown>(db: Db, key: string): T | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as T) : undefined;
}

/** Stored value if present, otherwise the fallback. */
export function getSettingOrDefault<T>(db: Db, key: string, fallback: T): T {
  const stored = getSetting<T>(db, key);
  return stored === undefined ? fallback : stored;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  const now = nowMs();
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

export function deleteSetting(db: Db, key: string): boolean {
  return db.delete(settings).where(eq(settings.key, key)).run().changes > 0;
}

export function listSettings(db: Db): SettingRow[] {
  return db.select().from(settings).orderBy(asc(settings.key)).all();
}

// ---------------------------------------------------------------------------
// Typed settings
// ---------------------------------------------------------------------------

/** The full settings object: defaults with every well-formed stored row over the top. */
export function getSettingsOrDefaults(db: Db): SettingsDTO {
  const out = settingsDefaults();
  Object.assign(out, coerceSettings(listSettings(db)));
  return out;
}

/** Merge a partial patch over the stored settings and persist the valid fields. */
export function putSettings(db: Db, patch: Partial<SettingsDTO>): SettingsDTO {
  const entries = Object.entries(patch).map(([key, value]) => ({ key, value }));
  const valid = coerceSettings(entries);

  for (const [key, value] of Object.entries(valid)) {
    if (value !== undefined) setSetting(db, key, value);
  }

  return getSettingsOrDefaults(db);
}
