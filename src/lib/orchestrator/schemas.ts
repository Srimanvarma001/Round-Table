import { z } from 'zod';

import {
  CRITIQUE_STANCES,
  MAX_PROFILE_ITEMS_PER_SOURCE,
  PROFILE_ITEM_KINDS,
  type StepName,
} from '@/shared/constants';

/**
 * Structured output schemas, Appendix A.
 *
 * Two rules drive every decision in this file:
 *
 * 1. **Field names are verbatim.** Appendix A says "Field names must match
 *    exactly; the prompt states them verbatim". `target_title`,
 *    `feasibility_weeks`, `merges_proposal_titles`, `why_it_won`,
 *    `first_steps` — snake_case, exactly as written. Renaming any of them
 *    silently breaks the contract with the prompt.
 *
 * 2. **Leniency where the penalty is a wasted call.** Appendix A fixes the
 *    *shape*; it does not require the run to burn a retry because a model
 *    wrote `"7"` instead of `7`, or `Support` instead of `support`. Every
 *    field below therefore coerces or `.catch()`es into a legal value rather
 *    than rejecting the whole object. Where a value is genuinely unusable
 *    (a critique with no `target_title`), the *step module* drops that single
 *    element with a recorded warning — section A.2 explicitly asks for that
 *    behaviour instead of task failure.
 *
 * `schemaPromptText()` renders the same shape back into the prompt verbatim,
 * so the schema the model is shown and the schema it is validated against can
 * never drift apart.
 */

// ---------------------------------------------------------------------------
// Shared field builders
// ---------------------------------------------------------------------------

/**
 * Coerce a value that should be a number. `z.coerce.number()` turns `"7"` and
 * `true` into numbers and `null`/`undefined` into `NaN` (which then fails or
 * catches), which is precisely the forgiving behaviour we want.
 */
function coerceFiniteNumber(): z.ZodType<number> {
  return z.coerce.number().refine((n) => Number.isFinite(n), {
    message: 'Expected a finite number',
  });
}

/**
 * Accept the array we asked for, and also the two near-misses models actually
 * produce: a bare string, and `null`.
 */
function stringList(): z.ZodType<string[]> {
  return z.preprocess((value) => {
    if (value === null || value === undefined) return [];
    if (typeof value === 'string') return value.trim() ? [value] : [];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    return [];
  }, z.array(z.string()));
}

/** Case-insensitive enum: models capitalise enum values constantly. */
function lowerEnum<T extends string>(values: readonly T[], fallback: T): z.ZodType<T> {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(values as unknown as [T, ...T[]]).catch(fallback),
  );
}

/**
 * A trimmed string.
 *
 * `maxLength` is a *safety* ceiling, deliberately looser than the length the
 * prompt asks for (a title is asked for at 80 characters and accepted up to
 * 256). Truncating an over-long title keeps an otherwise good proposal; failing
 * validation would spend a retry and then lose the proposal entirely.
 */
function trimmedString(minLength = 1, maxLength = 4000): z.ZodType<string> {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().slice(0, maxLength) : value),
    z.string().min(minLength),
  );
}

// ---------------------------------------------------------------------------
// A.1 Propose
// ---------------------------------------------------------------------------

export const ProposalDraftSchema = z.object({
  /** "string, max 80 chars, concrete project name" */
  title: trimmedString(1, 256).catch(''),
  /** "string, 2-4 sentences, what it is and what it does" */
  description: trimmedString().catch(''),
  /** "string, 1-2 sentences, why your lens favours this" */
  rationale: z.string().catch(''),
  /**
   * "integer estimate the Pragmatist seat and the reveal card both use".
   * Nullable: section A.3's refine schema and the DB column both allow the
   * estimate to be absent, and a missing estimate must not fail a proposal.
   */
  feasibility_weeks: coerceFiniteNumber()
    .transform((n) => Math.min(520, Math.max(0, Math.round(n))))
    .nullable()
    .catch(null),
});

/**
 * A.1: "One or two entries."
 *
 * The array is intentionally allowed to be EMPTY: the section B.1 system
 * contract tells a seat to "return an empty result rather than filler" when it
 * has nothing useful to add, so an empty list is a legitimate answer that the
 * propose step records as a warning. Anything past two entries is truncated by
 * the step module rather than rejected here.
 */
export const ProposeSchema = z.object({
  proposals: z.array(ProposalDraftSchema).catch([]),
});

export type ProposePayload = z.infer<typeof ProposeSchema>;

// ---------------------------------------------------------------------------
// A.2 Debate
// ---------------------------------------------------------------------------

export const CritiqueDraftSchema = z.object({
  /** "string, must match a title from the proposals list verbatim" */
  target_title: trimmedString().catch(''),
  stance: lowerEnum(CRITIQUE_STANCES, 'extend'),
  /** "string, 1-3 sentences, max 90 words" */
  comment: trimmedString().catch(''),
});

/**
 * A.2: "Two or three entries, and at least one must target a proposal the
 * agent did not author."
 *
 * That constraint is *not* enforced here. It is a quality requirement the step
 * verifies after title resolution, because a schema violation would cost a
 * retry while a warning costs nothing and keeps the run honest.
 */
export const DebateSchema = z.object({
  critiques: z.array(CritiqueDraftSchema).catch([]),
});

export type DebatePayload = z.infer<typeof DebateSchema>;

// ---------------------------------------------------------------------------
// A.3 Refine
// ---------------------------------------------------------------------------

export const RefinedDraftSchema = z.object({
  /** "string, max 80 chars" */
  title: trimmedString(1, 256).catch(''),
  /** "string, 2-4 sentences" */
  description: trimmedString().catch(''),
  /** "string, 1-2 sentences describing what changed and why" */
  rationale: z.string().catch(''),
  /** Titles this revision absorbs; resolved by the step's normalised matcher. */
  merges_proposal_titles: stringList(),
});

/**
 * A.3: "`refined` may be `null` when the agent chooses not to revise."
 *
 * `.catch(null)` also covers a model that omits the key entirely or returns a
 * string like "null" — all three mean the same thing to the engine, and none
 * of them should fail the task.
 */
export const RefineSchema = z.object({
  refined: RefinedDraftSchema.nullable().catch(null),
});

export type RefinePayload = z.infer<typeof RefineSchema>;

// ---------------------------------------------------------------------------
// A.4 Vote
// ---------------------------------------------------------------------------

export const VoteDraftSchema = z.object({
  /** "string, exact match required" */
  proposal_title: trimmedString().catch(''),
  /**
   * "integer from 1 to 10". A score outside the range is clamped to the lawful
   * band rather than rejected; a score that cannot be read at all becomes 1,
   * which is the same penalty section A.4 applies to a missing proposal, so an
   * unparseable score can never accidentally *help* a proposal.
   */
  score: coerceFiniteNumber()
    .transform((n) => Math.min(10, Math.max(1, Math.round(n))))
    .catch(1),
  /** "string, one sentence explaining the score" */
  comment: z.string().catch(''),
});

/** A.4: one call returns scores for every surviving proposal. */
export const VoteSchema = z.object({
  votes: z.array(VoteDraftSchema).catch([]),
});

export type VotePayload = z.infer<typeof VoteSchema>;

// ---------------------------------------------------------------------------
// A.5 Reveal
// ---------------------------------------------------------------------------

export const RevealSchema = z.object({
  title: trimmedString().catch(''),
  /** "string, 3-5 sentences, the winning idea expanded" */
  description: trimmedString().catch(''),
  /** "string, 2-4 sentences grounded in the vote pattern" */
  why_it_won: z.string().catch(''),
  /** "string, 3-5 concrete next actions" */
  first_steps: stringList(),
  /** "string, 2-4 risks drawn from the dissent" */
  risks: stringList(),
});

export type RevealPayloadData = z.infer<typeof RevealSchema>;

// ---------------------------------------------------------------------------
// A.6 Profile item extraction
// ---------------------------------------------------------------------------

export const ProfileItemDraftSchema = z.object({
  kind: lowerEnum(PROFILE_ITEM_KINDS, 'taste'),
  /** "string, max 60 chars" */
  label: trimmedString(1, 160).catch(''),
  /** "string, 1-3 sentences of evidence" */
  detail: z.string().catch(''),
  /** A guess is a guess: clamped to the 0..1 confidence band. */
  confidence: coerceFiniteNumber()
    .transform((n) => Math.min(1, Math.max(0, n)))
    .catch(0.5),
});

/**
 * A.6: "Maximum twelve items per source. The prompt requires conservative
 * output: emit nothing rather than speculate."
 *
 * Unlike the run-step schemas this one IS bounded, because section 10.3 makes
 * the cap a hard requirement of the extraction contract and the profile
 * pipeline has a repair retry of its own.
 */
export const ProfileExtractionSchema = z.object({
  items: z.array(ProfileItemDraftSchema).max(MAX_PROFILE_ITEMS_PER_SOURCE).catch([]),
});

export type ProfileExtractionPayload = z.infer<typeof ProfileExtractionSchema>;

// ---------------------------------------------------------------------------
// schemaPromptText — the shape, printed into the prompt verbatim
// ---------------------------------------------------------------------------

/**
 * Appendix A, transcribed character for character. These are not generated
 * from the Zod objects above: the appendix's values are *descriptions*
 * ("string, max 80 chars, concrete project name"), not types, and a model
 * shown `z.string().max(80)` produces worse JSON than one shown the example
 * object. Keeping the text literal also means a Zod tweak can never silently
 * change what the model is asked for.
 */

export const PROPOSE_SCHEMA_TEXT = `{
  "proposals": [
    {
      "title": "string, max 80 chars, concrete project name",
      "description": "string, 2-4 sentences, what it is and what it does",
      "rationale": "string, 1-2 sentences, why your lens favours this",
      "feasibility_weeks": 2
    }
  ]
}`;

export const DEBATE_SCHEMA_TEXT = `{
  "critiques": [
    {
      "target_title": "string, must match a title from the proposals list verbatim",
      "stance": "support | attack | extend",
      "comment": "string, 1-3 sentences, max 90 words"
    }
  ]
}`;

export const REFINE_SCHEMA_TEXT = `{
  "refined": {
    "title": "string, max 80 chars",
    "description": "string, 2-4 sentences",
    "rationale": "string, 1-2 sentences describing what changed and why",
    "merges_proposal_titles": ["string"]
  }
}`;

export const VOTE_SCHEMA_TEXT = `{
  "votes": [
    {
      "proposal_title": "string, exact match required",
      "score": 7,
      "comment": "string, one sentence explaining the score"
    }
  ]
}`;

export const REVEAL_SCHEMA_TEXT = `{
  "title": "string",
  "description": "string, 3-5 sentences, the winning idea expanded",
  "why_it_won": "string, 2-4 sentences grounded in the vote pattern",
  "first_steps": ["string, 3-5 concrete next actions"],
  "risks": ["string, 2-4 risks drawn from the dissent"]
}`;

export const PROFILE_EXTRACTION_SCHEMA_TEXT = `{
  "items": [
    {
      "kind": "skill | project | taste | experience | constraint | goal | anti_pattern",
      "label": "string, max 60 chars",
      "detail": "string, 1-3 sentences of evidence",
      "confidence": 0.85
    }
  ]
}`;

const STEP_SCHEMA_TEXT: Record<StepName, string> = {
  propose: PROPOSE_SCHEMA_TEXT,
  debate: DEBATE_SCHEMA_TEXT,
  refine: REFINE_SCHEMA_TEXT,
  vote: VOTE_SCHEMA_TEXT,
  reveal: REVEAL_SCHEMA_TEXT,
};

/**
 * The exact JSON shape injected into layer 1 of the prompt for a step
 * (section 9.1: the system contract "defines the output format, the JSON
 * schema for the current step").
 */
export function schemaPromptText(step: StepName): string {
  return STEP_SCHEMA_TEXT[step];
}

/**
 * The Zod schema the scheduler validates a step's output against. One lookup
 * so a step module and the prompt builder can never disagree.
 */
export function schemaForStep(step: StepName): z.ZodType {
  switch (step) {
    case 'propose':
      return ProposeSchema;
    case 'debate':
      return DebateSchema;
    case 'refine':
      return RefineSchema;
    case 'vote':
      return VoteSchema;
    case 'reveal':
      return RevealSchema;
  }
}
