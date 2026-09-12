import 'server-only';

import { z } from 'zod';

import { callWithStructuredOutput } from '@/lib/llm/json';
import { resolveAdapter } from '@/lib/llm/registry';
import type { AgentCallRequest, ChatMessage, LLMAdapter } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_PROFILE_ITEMS_PER_SOURCE,
  PROFILE_ITEM_KINDS,
  type ProfileItemKind,
  type ProfileItemSource,
  type ProviderKey,
} from '@/shared/constants';
import { normaliseLabel } from './merge';
import { GLM_MODEL_ID } from '@/lib/agents/defaults';

/**
 * LLM extraction, section 10.3.
 *
 * One call per source, temperature 0.2, `jsonMode: true`, producing an array of
 * items matching the `profile_items` shape:
 *
 *  - every emitted item carries the `source` of the ingestor it came from;
 *  - inferred items (taste, anti-patterns) are re-labelled `source: 'inferred'`
 *    with `confidence < 0.8`, so the editor can mark them as guesses (section
 *    7.3);
 *  - the prompt tells the model to be conservative and emit **nothing** rather
 *    than speculate, and output is hard-capped at
 *    `MAX_PROFILE_ITEMS_PER_SOURCE` (12) regardless of what it returns.
 *
 * This module never throws. A missing provider key, a schema violation, a
 * timeout or a malformed response all come back as `{ ok: false, warnings }`, so
 * a single bad source degrades the profile instead of failing the pipeline
 * (section 17.5).
 */

/** Extraction model, per the task brief: GLM's flash tier. */
export const EXTRACTION_MODEL = GLM_MODEL_ID;
export const EXTRACTION_PROVIDER: ProviderKey = 'glm';

/** Section 10.3 pins the temperature at 0.2. */
export const EXTRACTION_TEMPERATURE = 0.2;

/** Extraction returns up to twelve items, so it needs more room than a proposal. */
export const EXTRACTION_MAX_TOKENS = DEFAULT_MAX_TOKENS.extract;

/** Sources that can be extracted. `manual` is never generated (section 7.3). */
export const EXTRACTABLE_SOURCES = ['github', 'cv', 'local_scan', 'notes'] as const;
export type ExtractableSource = (typeof EXTRACTABLE_SOURCES)[number];

/** Kinds that are always inferences rather than statements of fact. */
export const INFERRED_KINDS: readonly ProfileItemKind[] = ['taste', 'anti_pattern'];

/** Inferred items must land below this, per section 10.3. */
export const INFERRED_CONFIDENCE_CEILING = 0.79;

/**
 * Appendix A.6, defined locally.
 *
 * `@/lib/orchestrator/schemas` does not exist yet (checked 2026-09-11); when it
 * does, this schema should be replaced by the shared export rather than
 * duplicated. It is named `profileExtractionSchema` so it is unambiguous in the
 * meantime.
 *
 * The item count is deliberately **not** capped in the schema: a model that
 * returns thirteen good items should have them truncated with a warning, not
 * have the whole response rejected as a structured-output failure (section
 * 17.4).
 */
export const profileExtractionSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(PROFILE_ITEM_KINDS),
      /** Max 60 characters, per A.6. */
      label: z.string().min(1).max(60),
      /** One to three sentences of evidence, per A.6 and section 7.3. */
      detail: z.string().min(1).max(800),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type RawExtractedItem = z.infer<typeof profileExtractionSchema>['items'][number];

export interface ExtractedProfileItem {
  kind: ProfileItemKind;
  label: string;
  detail: string;
  source: ProfileItemSource;
  confidence: number;
}

export interface ExtractionInput {
  /** Which ingestor produced the text. Determines the emitted `source`. */
  source: ExtractableSource;
  /** The rendered source document, for example `renderGithubSignalsForPrompt`. */
  text: string;
  /** Optional extra steer, for example the names of the folders scanned. */
  context?: string;
  signal?: AbortSignal;
}

export interface ExtractionDeps {
  /** Inject an adapter in tests; production resolves through the registry. */
  adapter?: LLMAdapter;
  timeoutMs?: number;
}

export interface ExtractionResult {
  ok: boolean;
  source: ExtractableSource;
  items: ExtractedProfileItem[];
  /** Non-fatal problems, surfaced through `RegenerateResponse.warnings`. */
  warnings: string[];
  /** Raw model text, kept for debugging a structured-output failure. */
  rawText: string;
  /** How many items the cap or deduplication removed. */
  droppedCount: number;
}

// ---------------------------------------------------------------------------
// Prompt (section 10.3)
// ---------------------------------------------------------------------------

const KIND_GUIDE: Record<ProfileItemKind, string> = {
  skill: 'A technology, tool or capability the person demonstrably has. Evidence required.',
  project: 'Something they built or shipped. Name it and say what it does.',
  taste: 'A stated or demonstrated preference about how they like to work or what they enjoy building.',
  experience: 'A role, domain or type of work they have actually done.',
  constraint: 'A real limit on what they can take on: time, money, location, skill gaps, commitments.',
  goal: 'Something they have said they want. Only from explicit statements or unmistakable evidence.',
  anti_pattern: 'Something they avoid, dislike or have repeatedly walked away from.',
};

function systemPrompt(source: ExtractableSource): string {
  const kindLines = PROFILE_ITEM_KINDS.map((kind) => `- "${kind}": ${KIND_GUIDE[kind]}`).join('\n');

  const sourceRule =
    source === 'notes'
      ? [
          'The source is the user\'s own hand-written notes. Statements in it are the user speaking',
          'about themselves, so a stated preference is a fact about them, not a guess. Record taste',
          'statements as "taste" items with confidence at or above 0.8 when they are stated plainly.',
        ].join('\n')
      : [
          'The source is evidence, not a self-description. Anything you conclude about preferences,',
          'taste or dislikes is an INFERENCE and must be reported as such.',
        ].join('\n');

  return [
    'You extract a structured personal profile from raw evidence about one person.',
    'This profile is injected into a multi-agent idea workshop, so a wrong item is worse than a missing one.',
    '',
    'Rules, in order of importance:',
    '1. Be conservative. Only emit an item you can point at specific evidence for in the source.',
    '2. If the evidence is thin, ambiguous or generic, emit NOTHING for it. An empty list is a',
    '   perfectly good answer. Never speculate, never pad, never invent a plausible-sounding item.',
    '3. Emit at most 12 items. Fewer is better. Prefer the items with the strongest evidence.',
    '4. One item per distinct fact. Do not split one fact across two items and do not repeat.',
    '5. "label" is a short name, at most 60 characters, for example "TypeScript" or "Abandoned side projects".',
    '6. "detail" is one to three sentences and must cite the evidence you saw, not a general claim.',
    '7. "confidence" is your honest probability that the item is true of this person, from 0 to 1.',
    '   Anything you inferred rather than read directly must be below 0.8.',
    '8. Never emit kind "manual": that kind is reserved for the user.',
    '',
    'Allowed kinds:',
    kindLines,
    '',
    sourceRule,
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"items":[{"kind":"skill","label":"...","detail":"...","confidence":0.9}]}',
    'If you have no well-evidenced items, respond with {"items":[]}.',
  ].join('\n');
}

function userPrompt(input: ExtractionInput): string {
  const parts: string[] = [`Source: ${input.source}`];
  if (input.context) parts.push(`Context: ${input.context}`);
  parts.push('', 'Evidence:', input.text.trim() || '(no evidence was available)');
  return parts.join('\n');
}

/** The exact messages sent for a source. Exported so the prompt is inspectable. */
export function buildExtractionMessages(input: ExtractionInput): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(input.source) },
    { role: 'user', content: userPrompt(input) },
  ];
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

/**
 * The shape `callWithStructuredOutput` is expected to have. It is typed
 * structurally here so this module keeps compiling while the orchestrator's
 * module settles, and so a change of return shape degrades to a warning instead
 * of a type error.
 */
type StructuredCallFn = (
  adapter: LLMAdapter,
  req: AgentCallRequest,
  schema: unknown,
  signal: AbortSignal,
  opts?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Run the extraction call for one source. Never throws.
 */
export async function extractProfileItems(
  input: ExtractionInput,
  deps: ExtractionDeps = {},
): Promise<ExtractionResult> {
  const base: ExtractionResult = {
    ok: false,
    source: input.source,
    items: [],
    warnings: [],
    rawText: '',
    droppedCount: 0,
  };

  const text = input.text?.trim() ?? '';
  if (text.length === 0) {
    return { ...base, ok: true, warnings: [`No ${input.source} evidence to extract from; nothing was sent to the model.`] };
  }

  let adapter: LLMAdapter;
  try {
    adapter = deps.adapter ?? resolveAdapter(EXTRACTION_PROVIDER);
  } catch (err) {
    return {
      ...base,
      warnings: [`No ${EXTRACTION_PROVIDER} adapter available for ${input.source} extraction: ${message(err)}`],
    };
  }

  const { signal, dispose } = withTimeout(input.signal, deps.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  const request: AgentCallRequest = {
    provider: EXTRACTION_PROVIDER,
    modelId: EXTRACTION_MODEL,
    messages: buildExtractionMessages(input),
    temperature: EXTRACTION_TEMPERATURE,
    maxTokens: EXTRACTION_MAX_TOKENS,
    jsonMode: true,
    reasoning: false,
    label: `profile.extract.${input.source}`,
  };

  try {
    const call = callWithStructuredOutput as unknown as StructuredCallFn;
    const raw = await call(adapter, request, profileExtractionSchema, signal, {
      attempts: 2,
      label: `profile.extract.${input.source}`,
    });

    const rawText = rawToText(raw);
    const parsed = profileExtractionSchema.safeParse(unwrapStructuredResult(raw));

    if (!parsed.success) {
      // Section 17.4: a validation failure is recorded, not thrown. The raw
      // text is kept so the editor can show what the model actually said.
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return {
        ...base,
        rawText,
        warnings: [`${input.source} extraction did not match the A.6 schema (${issues}).`],
      };
    }

    const normalised = normaliseExtractedItems(parsed.data.items, input.source);
    return {
      ok: true,
      source: input.source,
      items: normalised.items,
      warnings: normalised.warnings,
      rawText,
      droppedCount: normalised.droppedCount,
    };
  } catch (err) {
    logger.warn({ err, source: input.source }, 'profile.extract: extraction call failed');
    return {
      ...base,
      warnings: [`${input.source} extraction failed: ${message(err)}`],
    };
  } finally {
    dispose();
  }
}

/**
 * `callWithStructuredOutput` may hand back the parsed value directly or wrap it
 * alongside the raw response; accept either without guessing wrong.
 */
function unwrapStructuredResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    for (const key of ['value', 'data', 'parsed', 'json', 'result', 'output']) {
      const inner = candidate[key];
      if (inner && typeof inner === 'object' && Array.isArray((inner as { items?: unknown }).items)) {
        return inner;
      }
    }
    if (Array.isArray(candidate.items)) return candidate;
  }
  return raw;
}

function rawToText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    for (const key of ['rawText', 'raw', 'text', 'content']) {
      const value = candidate[key];
      if (typeof value === 'string') return value;
    }
    try {
      return JSON.stringify(raw);
    } catch {
      return '';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Normalisation (the guarantees section 10.3 asks for)
// ---------------------------------------------------------------------------

/**
 * Turn whatever the model returned into items that satisfy section 10.3:
 * the right `source`, inferred items kept below the confidence ceiling, no
 * duplicates and at most `MAX_PROFILE_ITEMS_PER_SOURCE` of them.
 *
 * Exported because the guarantees are worth testing directly, and because the
 * pipeline re-runs it on cached extractions.
 */
export function normaliseExtractedItems(
  rawItems: readonly RawExtractedItem[],
  source: ExtractableSource,
): { items: ExtractedProfileItem[]; warnings: string[]; droppedCount: number } {
  const warnings: string[] = [];
  const items: ExtractedProfileItem[] = [];
  const seen = new Set<string>();
  let droppedCount = 0;

  for (const raw of rawItems) {
    const label = raw.label.trim().replace(/\s+/g, ' ').slice(0, 60);
    const detail = raw.detail.trim().replace(/\s+/g, ' ');
    if (!label || !detail) {
      droppedCount += 1;
      continue;
    }

    const inferred = INFERRED_KINDS.includes(raw.kind) && source !== 'notes';
    const itemSource: ProfileItemSource = inferred ? 'inferred' : source;

    // Section 10.3: inferred items are always below 0.8, whatever the model claims.
    const confidence = inferred
      ? Math.min(clamp01(raw.confidence), INFERRED_CONFIDENCE_CEILING)
      : clamp01(raw.confidence);

    const key = `${raw.kind}:${normaliseLabel(label)}`;
    if (seen.has(key)) {
      droppedCount += 1;
      continue;
    }
    seen.add(key);

    if (items.length >= MAX_PROFILE_ITEMS_PER_SOURCE) {
      droppedCount += 1;
      continue;
    }

    items.push({ kind: raw.kind, label, detail, source: itemSource, confidence });
  }

  if (droppedCount > 0) {
    warnings.push(
      `${source} extraction: ${droppedCount} item(s) dropped (duplicates, empty fields, or over the ${MAX_PROFILE_ITEMS_PER_SOURCE}-item cap).`,
    );
  }

  return { items, warnings, droppedCount };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** AbortSignal plus a timeout, without depending on `AbortSignal.any` (Node 18). */
function withTimeout(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  // A pending timer must not keep the Node process alive. Typed defensively
  // because the DOM and Node typings disagree about what `setTimeout` returns.
  if (typeof (timer as { unref?: unknown }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
