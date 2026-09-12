/**
 * Cross-cutting constants shared by server and client.
 * No imports from `lib/*` here — this module must stay bundle-safe.
 */

export const STEP_NAMES = ['propose', 'debate', 'refine', 'vote', 'reveal'] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type StepOrDone = StepName | 'done';

export const RUN_STATUSES = [
  'created',
  'running',
  'paused',
  'completed',
  'failed',
  'aborted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'aborted'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const PROVIDERS = ['glm', 'mock'] as const;
export type ProviderKey = (typeof PROVIDERS)[number];

export const SEAT_CLASSES = ['me', 'lens'] as const;
export type SeatClass = (typeof SEAT_CLASSES)[number];

export const PROFILE_ITEM_KINDS = [
  'skill',
  'project',
  'taste',
  'experience',
  'constraint',
  'goal',
  'anti_pattern',
] as const;
export type ProfileItemKind = (typeof PROFILE_ITEM_KINDS)[number];

export const PROFILE_ITEM_SOURCES = [
  'github',
  'cv',
  'local_scan',
  'notes',
  'inferred',
  'manual',
] as const;
export type ProfileItemSource = (typeof PROFILE_ITEM_SOURCES)[number];

export const CRITIQUE_STANCES = ['support', 'attack', 'extend'] as const;
export type CritiqueStance = (typeof CRITIQUE_STANCES)[number];

export const SEAT_STATES = ['idle', 'thinking', 'spoken', 'failed', 'disabled'] as const;
export type SeatState = (typeof SEAT_STATES)[number];

export const AVATAR_STYLES = ['dicebear', 'lucide', 'initials'] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

/** Stable seat keys. The Me Agent is always `seat_me`. */
export const SEAT_KEYS = [
  'seat_me',
  'seat_pragmatist',
  'seat_wildcard',
  'seat_market_analyst',
  'seat_technical_architect',
  'seat_contrarian',
  'seat_mentor',
  'seat_trend_watcher',
] as const;
export type SeatKey = (typeof SEAT_KEYS)[number];

export const ME_SEAT_KEY: SeatKey = 'seat_me';

// ---------------------------------------------------------------------------
// Scoring defaults (section 12)
// ---------------------------------------------------------------------------

/** The Me Agent holds 25 percent; the lens seats split the rest evenly. */
export const DEFAULT_ME_WEIGHT = 0.25;
export const DEFAULT_LENS_WEIGHT = 0.75 / 7;

/** Dissent: score at or below mean - 2, or below this on the winner. */
export const DISSENT_MEAN_MARGIN = 2;
export const DISSENT_WINNER_FLOOR = 5;

export const MIN_SCORE = 1;
export const MAX_SCORE = 10;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'BUDGET_EXCEEDED',
  'INSUFFICIENT_PROPOSALS',
  'PROCESS_RESTART',
  'PROVIDER_OUTAGE',
  'MISSING_PROVIDER_KEY',
  'STRUCTURED_OUTPUT',
  'TOKEN_LIMIT_EXCEEDED',
  'CALL_LIMIT_EXCEEDED',
  'INVALID_TRANSITION',
  'NOT_FOUND',
  'VALIDATION',
  'TIMEOUT',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Layout / motion defaults (section 16)
// ---------------------------------------------------------------------------

export const RADIUS_X = 0.45;
export const RADIUS_Y = 0.42;
export const TABLE_ASPECT = 16 / 10;
export const DEFAULT_STAGGER_CADENCE_MS = 45;
export const STAGGER_HIGH_WATER_CHARS = 4000;

// ---------------------------------------------------------------------------
// Budget and call defaults (section 17)
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = {
  propose: 800,
  debate: 500,
  refine: 800,
  vote: 600,
  reveal: 1200,
  extract: 1500,
} as const;

export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_RETRIES = 2;
export const RETRY_BACKOFF_MS = [1000, 4000] as const;
export const DEFAULT_CONCURRENCY = 8;

/** Refine fans out per proposal but is capped, per section 11.3. */
export const MAX_REFINE_SEATS = 4;

/** Critique/fan-out caps. */
export const MAX_CRITIQUES_PER_AGENT = 3;
export const MAX_PROPOSALS_PER_AGENT = 2;
export const MAX_PROFILE_ITEMS_PER_SOURCE = 12;

/** `author_brief` hard cap, section 10.5. */
export const AUTHOR_BRIEF_WORD_CAP = 400;

/** A run fails if a step leaves fewer than this many active proposals. */
export const MIN_ACTIVE_PROPOSALS = 3;

/** Delta coalescing window, section 13.2. */
export const DELTA_COALESCE_MS = 40;
export const DELTA_COALESCE_CHARS = 40;

/** SSE heartbeat interval, section 13.4. */
export const SSE_HEARTBEAT_MS = 15_000;

export const DEFAULT_THEME = 'warroom' as const;
export const THEMES = ['warroom', 'hearth'] as const;
export type ThemeName = (typeof THEMES)[number];
