/**
 * The eight seeded seats, the shared system contract, and the seat icon map.
 *
 * Spec references:
 *  - section 9.2  the eight seats and their evaluative lenses
 *  - section 9.1  prompt structure (contract is code, lens is data)
 *  - section 9.3  prompt requirements, including the per-step word limits
 *  - Appendix B   verbatim prompt templates (B.1 contract, B.2 to B.9 lenses)
 *  - section 8.4  model assignment, corrected by docs/PROVIDER-NOTES.md section 1
 *  - section 16.3 lucide icon per seat
 *  - section 16.4 accent palette
 *
 * The lens prompts below are copied verbatim from Appendix B. They are DATA:
 * the user edits them on `/agents`. The system contract in this file is CODE
 * (section 9.1) and is never editable, which is what makes the seat editor safe.
 */

import {
  DEFAULT_LENS_WEIGHT,
  DEFAULT_ME_WEIGHT,
  ME_SEAT_KEY,
  type AvatarStyle,
  type ProviderKey,
  type SeatKey,
  type StepName,
} from '@/shared/constants';

// ---------------------------------------------------------------------------
// Model identifiers (section 8.4, corrected)
// ---------------------------------------------------------------------------

/**
 * docs/PROVIDER-NOTES.md section 1 supersedes the model column of section 8.4.
 * The spec named `glm-4.6`; the provider actually serves `glm-5.3-flash` under
 * the name the product owner specified.
 *
 * OWNER CHANGE, 2026-09-11: DeepSeek was removed entirely and every seat —
 * and the reveal synthesis — runs on GLM, the single configured provider.
 * Re-adding a second provider later is a constants change (`PROVIDERS` in
 * `shared/constants.ts`) plus a registry entry, not a rewrite; the
 * provider-outage drill in section 17.5 is still exercised by the integration
 * tests via seat-level failure injection.
 */
export const GLM_MODEL_ID = 'glm-5.3-flash';

// ---------------------------------------------------------------------------
// Seeded seat shape
// ---------------------------------------------------------------------------

/**
 * One seeded seat, matching the editable columns of the `agents` table
 * (section 7.4). `id`, `user_id`, `avatar_svg_cache`, `created_at` and
 * `updated_at` are not part of the seed data: they are assigned at insert time
 * by the seed script / `createAgent()`.
 */
export interface DefaultSeat {
  seatKey: SeatKey;
  name: string;
  isMeAgent: boolean;
  lensPrompt: string;
  provider: ProviderKey;
  modelId: string;
  temperature: number;
  weight: number;
  avatarStyle: AvatarStyle;
  avatarSeed: string;
  accentColor: string;
  accentToken: string;
  iconName: string;
  enabled: boolean;
  orderIndex: number;
}

/**
 * Section 6.2 exposes a "default temperature per seat class" setting; these are
 * the seeded values it overrides. The Me Agent runs cooler because its output
 * is grounded in a real profile it must not embellish.
 */
export const DEFAULT_TEMPERATURE_BY_SEAT_CLASS = {
  me: 0.5,
  lens: 0.7,
} as const;

/** Seats default to the character sprites in `public/characters/`. */
export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'pixel';

/**
 * Section 7.1: the Me Agent's seat label is the `users.display_name`. The seed
 * script overwrites this placeholder with the real one; it exists only so the
 * seed data is complete on its own.
 */
export const ME_AGENT_FALLBACK_NAME = 'You';

// ---------------------------------------------------------------------------
// Appendix B, B.2 to B.9 — lens prompts, verbatim
// ---------------------------------------------------------------------------

/** B.2 The Pragmatist. */
const PRAGMATIST_LENS = `You judge every idea by one question: can this be shipped in two weeks, by one
person, with tools they already know? You reward small scope, boring technology,
and a first version that works on day one. You punish anything requiring a
trained model, a hardware purchase, a data acquisition problem, or a design
system. Estimate weeks honestly and call out the single step most likely to
stall the project.`;

/** B.3 The Wildcard. */
const WILDCARD_LENS = `You exist to prevent boring answers. You push the strange, the playful, the
technically unnecessary, the idea that makes someone say "why would you build
that" and then want it anyway. Reject anything that looks like a portfolio
project or a tutorial rebuild. One of your ideas should be genuinely odd but
still buildable by one person. Novelty of interaction matters more than novelty
of stack.`;

/** B.4 The Market Analyst. */
const MARKET_ANALYST_LENS = `You care about whether anyone would use or pay for this. You look for a real
problem with a specific user, an existing behaviour you can improve, and a
plausible path to the first ten users. You are sceptical of ideas whose only
user is the builder. When you critique, name the user, the alternative they use
today, and what would have to be true for them to switch.`;

/** B.5 The Technical Architect. */
const TECHNICAL_ARCHITECT_LENS = `You judge engineering quality and learning value. You favour ideas where the
interesting part is the structure: a protocol, a pipeline, a state machine, a
data model, an interface boundary. You are bored by CRUD and by thin wrappers
around an API. You ask what the system has to get right, what the hard invariant
is, and what the builder will understand better at the end than at the start.`;

/** B.6 The Contrarian. */
const CONTRARIAN_LENS = `You attack. You attack the strongest idea in the room, not the weakest, because
that is where the value is. For every proposal you name the specific reason it
fails: the hidden assumption, the dependency that will break, the part that
sounds easy and is not, the reason the builder will quit in week three. State
what evidence would change your mind. You are not negative for sport: you are
the reason the surviving idea is actually good.`;

/** B.7 The Mentor. */
const MENTOR_LENS = `You are a senior engineer who has watched this person's history. You know their
pattern of abandoned projects and you name it directly when an idea repeats it.
You flag scope creep, unclear stopping conditions, and ideas whose appeal comes
from the setup rather than the thing itself. You favour ideas with a visible
finish line and a working artefact at the end of week one. Be warm but blunt.`;

/** B.8 The Trend-Watcher. */
const TREND_WATCHER_LENS = `You bring the outside world. You receive live search results and use them: what
shipped recently, what is saturated, what just became possible because a model,
API, or price changed. You call out ideas that already exist in five forms, and
you point at newly viable directions. Cite what you found in plain terms; never
invent a source or a product that is not in your search results.`;

/** B.9 The Me Agent. */
export const ME_AGENT_LENS = `You are the user's own voice at the table, built from their real history.

You know their actual stack, their real skill level, what they finish, what they
abandon, and what they claim to want. Your job is to propose only work this
specific person will actually complete, and to vote against ideas that flatter
them but do not fit.

Cite the profile when you propose or object: name the skill, the constraint, or
the past pattern you are reasoning from. If an idea is exciting but conflicts
with a stated constraint, say so plainly and still let the table decide.

You carry 25 percent of the vote. Do not use it to be agreeable.`;

/** Lens prompt per seat key, for callers that need one seat rather than all. */
export const LENS_PROMPTS: Record<SeatKey, string> = {
  seat_me: ME_AGENT_LENS,
  seat_pragmatist: PRAGMATIST_LENS,
  seat_wildcard: WILDCARD_LENS,
  seat_market_analyst: MARKET_ANALYST_LENS,
  seat_technical_architect: TECHNICAL_ARCHITECT_LENS,
  seat_contrarian: CONTRARIAN_LENS,
  seat_mentor: MENTOR_LENS,
  seat_trend_watcher: TREND_WATCHER_LENS,
};

// ---------------------------------------------------------------------------
// The eight seats (section 9.2 listing order, section 16.4 accents)
// ---------------------------------------------------------------------------

/**
 * Seat order is the section 9.2 table order with the Me Agent moved to the
 * head: `order_index` drives the seat position around the table (section 16.1)
 * and the Me Agent is always index 0, at 12 o'clock.
 */
export const DEFAULT_SEATS: readonly DefaultSeat[] = [
  {
    seatKey: ME_SEAT_KEY,
    name: ME_AGENT_FALLBACK_NAME,
    isMeAgent: true,
    lensPrompt: ME_AGENT_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.me,
    weight: DEFAULT_ME_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '3_knight',
    accentColor: '#7FB392',
    accentToken: '--seat-1',
    iconName: 'user-round',
    enabled: true,
    orderIndex: 0,
  },
  {
    seatKey: 'seat_pragmatist',
    name: 'The Pragmatist',
    isMeAgent: false,
    lensPrompt: PRAGMATIST_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '1_knight',
    accentColor: '#6B8F6B',
    accentToken: '--seat-2',
    iconName: 'hammer',
    enabled: true,
    orderIndex: 1,
  },
  {
    seatKey: 'seat_wildcard',
    name: 'The Wildcard',
    isMeAgent: false,
    lensPrompt: WILDCARD_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '2_fairy',
    accentColor: '#8B5E3C',
    accentToken: '--seat-3',
    iconName: 'dices',
    enabled: true,
    orderIndex: 2,
  },
  {
    seatKey: 'seat_market_analyst',
    name: 'The Market Analyst',
    isMeAgent: false,
    lensPrompt: MARKET_ANALYST_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '1_pirate',
    accentColor: '#6F9A9A',
    accentToken: '--seat-4',
    iconName: 'trending-up',
    enabled: true,
    orderIndex: 3,
  },
  {
    seatKey: 'seat_technical_architect',
    name: 'The Technical Architect',
    isMeAgent: false,
    lensPrompt: TECHNICAL_ARCHITECT_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '2_knight',
    accentColor: '#B08287',
    accentToken: '--seat-5',
    iconName: 'blocks',
    enabled: true,
    orderIndex: 4,
  },
  {
    seatKey: 'seat_contrarian',
    name: 'The Contrarian',
    isMeAgent: false,
    lensPrompt: CONTRARIAN_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '3_pirate',
    accentColor: '#B1503F',
    accentToken: '--seat-6',
    iconName: 'swords',
    enabled: true,
    orderIndex: 5,
  },
  {
    seatKey: 'seat_mentor',
    name: 'The Mentor',
    isMeAgent: false,
    lensPrompt: MENTOR_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '3_fairy',
    accentColor: '#8577B0',
    accentToken: '--seat-7',
    iconName: 'compass',
    enabled: true,
    orderIndex: 6,
  },
  {
    seatKey: 'seat_trend_watcher',
    name: 'The Trend-Watcher',
    isMeAgent: false,
    lensPrompt: TREND_WATCHER_LENS,
    provider: 'glm',
    modelId: GLM_MODEL_ID,
    temperature: DEFAULT_TEMPERATURE_BY_SEAT_CLASS.lens,
    weight: DEFAULT_LENS_WEIGHT,
    avatarStyle: DEFAULT_AVATAR_STYLE,
    avatarSeed: '2_pirate',
    accentColor: '#A89A7E',
    accentToken: '--seat-8',
    iconName: 'radar',
    enabled: true,
    orderIndex: 7,
  },
];

/** Seat key to seeded seat, for lookups that need the seed rather than the DB row. */
export const DEFAULT_SEAT_BY_KEY: Record<SeatKey, DefaultSeat> = Object.fromEntries(
  DEFAULT_SEATS.map((seat) => [seat.seatKey, seat]),
) as Record<SeatKey, DefaultSeat>;

/**
 * Section 16.3's icon table, plus the seeded default for any seat the user
 * adds later. lucide-react is a client dependency, so this module stores the
 * icon NAME and the component layer resolves it.
 */
export const SEAT_ICONS: Record<SeatKey, string> = {
  seat_me: 'user-round',
  seat_pragmatist: 'hammer',
  seat_wildcard: 'dices',
  seat_market_analyst: 'trending-up',
  seat_technical_architect: 'blocks',
  seat_contrarian: 'swords',
  seat_mentor: 'compass',
  seat_trend_watcher: 'radar',
};

export const FALLBACK_SEAT_ICON = 'user-round';

/** Icon name for a seat key. Unknown (user-added) seats get the neutral glyph. */
export function lucideIconFor(seatKey: string): string {
  return SEAT_ICONS[seatKey as SeatKey] ?? FALLBACK_SEAT_ICON;
}

// ---------------------------------------------------------------------------
// Appendix B.1 — the system contract (code constant, never editable)
// ---------------------------------------------------------------------------

/**
 * B.1, verbatim. Shared by all seats; contains no persona (section 9.1).
 * Use `renderSystemContract()` to fill in `{seat name}` and append the
 * per-step word limits from section 9.3.
 */
export const SYSTEM_CONTRACT = `You are a participant in a structured multi-agent idea workshop. You have one
role: {seat name}. You speak only from that role's perspective.

Rules:
- Output only the requested JSON object. No prose before or after it.
- Never mention that you are an AI, never address the user, never describe
  your own process.
- Be concrete. Name technologies, name the user-facing action, name the outcome.
- Respect the word limits given in the task.
- Do not repeat an idea already present in the discussion.
- If you have nothing useful to add, return an empty result rather than filler.`;

/** The placeholder B.1 substitutes. */
export const SEAT_NAME_PLACEHOLDER = '{seat name}';

/**
 * Section 9.3's hard length limits, restated per step. These are stated in the
 * contract as well as enforced through the matching `maxTokens` in the request
 * (section 17.1), because a limit the model cannot see is not a limit.
 */
export const STEP_WORD_LIMITS: Record<StepName, string> = {
  propose: 'each idea is at most 220 words across its title, description and rationale',
  debate: 'each critique comment is at most 90 words',
  refine: 'the refined idea is at most 220 words',
  vote: 'each vote comment is exactly one sentence',
  // Section 9.3 states limits for propose, critique, vote and refine only.
  // Reveal is bounded by the section 17.1 maxTokens budget instead.
  reveal: 'stay inside the reveal maxTokens budget (section 17.1); no word limit is imposed',
};

/**
 * Per-step addendum appended to the contract. Section 9.3 requires the
 * "do not repeat" phrasing in propose and refine specifically, and the
 * Contrarian's attack-the-strongest instruction is in its lens (B.6) as well
 * as restated in the debate addendum so every seat critiques to the same bar.
 */
export const STEP_ADDENDA: Record<StepName, string> = {
  propose: [
    'This step: propose.',
    '- Propose at most two ideas. Each idea is at most 220 words across title, description and rationale.',
    '- Do not repeat an idea already present in the discussion.',
    '- Return the propose JSON object.',
  ].join('\n'),
  debate: [
    'This step: debate (critique).',
    '- Write at most three critiques. Each critique comment is at most 90 words.',
    '- Critique the strongest proposal in the room, not the weakest.',
    '- State what evidence would change your mind.',
    '- Return the debate JSON object.',
  ].join('\n'),
  refine: [
    'This step: refine.',
    '- Revise, merge, or withdraw your own proposal. The refined idea is at most 220 words.',
    '- Do not repeat an idea already present in the discussion.',
    '- Return the refine JSON object.',
  ].join('\n'),
  vote: [
    'This step: vote.',
    '- Score every surviving proposal from 1 to 10. Each vote comment is exactly one sentence.',
    '- Use the full range; do not cluster at 7.',
    '- Return the vote JSON object.',
  ].join('\n'),
  reveal: [
    'This step: reveal.',
    '- Expand the winning proposal into a buildable plan and ground the rationale in the vote pattern.',
    '- Stay inside the reveal maxTokens budget (section 17.1).',
    '- Return the reveal JSON object.',
  ].join('\n'),
};

/** Every step's limit at once, for a call that is not step-scoped. */
const ALL_WORD_LIMITS = [
  'Word limits (section 9.3):',
  ...Object.values(STEP_WORD_LIMITS).map((limit) => `- ${limit}.`),
].join('\n');

/**
 * Render the B.1 contract for one seat, optionally with the step's addendum.
 * The seat name is the only substitution; the contract is otherwise fixed, so
 * a seat can never drift in format from the others (section 9.3).
 */
export function renderSystemContract(seatName: string, step?: StepName): string {
  const base = SYSTEM_CONTRACT.replaceAll(SEAT_NAME_PLACEHOLDER, seatName);
  const addendum = step ? STEP_ADDENDA[step] : ALL_WORD_LIMITS;
  return `${base}\n\n${addendum}`;
}

/**
 * Section 9.2: the Me Agent gets two extra blocks on top of the shared
 * contract -- the full profile summary in place of the short brief, and an
 * explicit finish-it instruction citing the profile's anti_pattern and
 * constraint items. The profile text itself is injected by the context
 * builder; this is the instruction half.
 */
export const ME_AGENT_FINISH_INSTRUCTION = `Propose only work this profile will actually finish. Cite the anti_pattern and
constraint items above wherever they bear on the idea, and say plainly when an
idea conflicts with one.`;
