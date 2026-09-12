import type { ZodType } from 'zod';

import {
  StructuredOutputError,
  type AgentCallRequest,
  type AgentCallResult,
  type LLMAdapter,
} from './types';

/**
 * Structured output: extract, validate, repair once, retry once.
 * Section 8.3 rule 3 and section 17.4.
 *
 * JSON mode is a hint and is treated as one. Neither provider guarantees a
 * bare JSON body: the response can be wrapped in prose, wrapped in a markdown
 * fence, truncated by the token limit, or — for a reasoning model — placed in
 * the reasoning channel with an empty content channel. Every one of those is
 * handled here rather than trusted away.
 *
 * This module deliberately does NOT import `server-only`; vitest imports it
 * directly and it holds no secrets.
 */

/** The terse corrective message appended for the single repair retry. */
export const REPAIR_INSTRUCTION =
  'Your previous reply was not valid JSON matching the schema. ' +
  'Reply with only the JSON object: no prose, no explanation, no markdown fence.';

/**
 * Appended to `label` on the repair retry so the two calls are distinguishable
 * in the logs and in the reasoning drawer. `label` is documented as free-form
 * and log-only, so nothing downstream may key off it — `mock.ts` normalises
 * this suffix away when it counts attempts.
 */
export const REPAIR_LABEL_SUFFIX = ':repair';

/**
 * Pick the channel a structured reply should be read from.
 *
 * docs/PROVIDER-NOTES.md section 5: a reasoning model will happily emit the
 * JSON into the reasoning channel and leave the content channel empty, so the
 * content channel is preferred and the reasoning channel is the fallback. The
 * fallback is used ONLY when content is blank — never merged, or a model that
 * reasons about a draft before writing the final JSON would have its draft
 * parsed instead of its answer.
 */
export function selectStructuredText(result: AgentCallResult): string {
  return result.contentText.trim().length > 0 ? result.contentText : result.reasoningText;
}

/**
 * Return the FIRST BALANCED JSON object in `text`, or `null` if there is none.
 *
 * A real scanner rather than a regex, because both of the things a regex gets
 * wrong here are common in model output:
 *  - a `}` inside a string value must not close the object
 *    (`{"note": "close it with }"}`), and
 *  - a `{` inside a string must not open a nested one.
 *
 * The scan therefore tracks three states: whether it is inside a string,
 * whether the previous character escaped the current one, and the brace depth.
 * It starts at the first `{` and ends at the `}` that returns the depth to
 * zero, which transparently handles clean JSON, JSON wrapped in prose and JSON
 * inside a ```json fence — no fence stripping needed, since the fence
 * characters are simply skipped as ordinary text outside a string.
 *
 * A truncated object (the `finish_reason: 'length'` case from notes section 3)
 * never returns to depth zero and yields `null`, which is what turns it into a
 * schema failure and therefore into the single repair retry.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        // The previous character was a backslash, so this one is literal —
        // even if it is a quote or another backslash.
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Extract the first balanced JSON object and validate it with Zod.
 *
 * Throws `StructuredOutputError` carrying the raw text whenever extraction,
 * parsing or validation fails, so the caller has the model's actual reply to
 * persist against the task (section 17.4).
 */
export function parseStructured<T>(text: string, schema: ZodType<T>): T {
  const raw = extractJsonObject(text);
  if (raw === null) {
    throw new StructuredOutputError(
      'No balanced JSON object found in the response.',
      text,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StructuredOutputError(
      `Extracted object is not valid JSON: ${errorMessage(err)}`,
      text,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError(
      `Response does not match the expected schema: ${formatIssues(result.error.issues)}`,
      text,
    );
  }

  return result.data;
}

export interface StructuredCallOptions {
  /** Override the corrective user message. Exists for tests. */
  repairInstruction?: string;
}

/**
 * The wrapper a step module uses.
 *
 * Returning the whole result rather than a bare `T` is deliberate: the caller
 * still needs the token counts for the budget guard (section 17.2) and the
 * request/response pair for `agent_messages` (section 7.10), and re-running
 * the call to recover them would double-count against `RUN_MAX_CALLS`.
 */
export interface StructuredCallResult<T> {
  value: T;
  /** The call that produced `value` — the repair retry when `attempts` is 2. */
  result: AgentCallResult;
  /** 1 when the first attempt validated, 2 when the repair retry did. */
  attempts: number;
  /** The raw text `value` was parsed from, for `agent_messages.content_text`. */
  rawText: string;
}

/**
 * Perform the call, validate, and on failure perform EXACTLY ONE repair retry.
 *
 * The retry appends the model's own previous reply plus a terse corrective
 * message. Section 8.3 rule 3 fixes the retry count at one: the scheduler's
 * retry policy then handles the second failure, and section 17.4 records it as
 * `StructuredOutputError` against the task. A second consecutive failure is
 * raised here and never silently retried a third time.
 */
export async function callWithStructuredOutput<T>(
  adapter: LLMAdapter,
  req: AgentCallRequest,
  schema: ZodType<T>,
  signal: AbortSignal,
  opts: StructuredCallOptions = {},
): Promise<StructuredCallResult<T>> {
  const first = await adapter.complete(req, signal);
  const firstAttempt = attemptParse(first, schema);

  if (firstAttempt.ok) {
    return { value: firstAttempt.value, result: first, attempts: 1, rawText: firstAttempt.rawText };
  }

  // Echo the bad reply back as an assistant turn, then correct it. Keeping the
  // original messages (rather than restarting with a "shortened" context) is
  // what makes the correction meaningful: the model can see the exact text it
  // produced against the schema it was given.
  const repairRequest: AgentCallRequest = {
    ...req,
    label: req.label ? `${req.label}${REPAIR_LABEL_SUFFIX}` : `repair${REPAIR_LABEL_SUFFIX}`,
    messages: [
      ...req.messages,
      { role: 'assistant', content: firstAttempt.rawText },
      { role: 'user', content: opts.repairInstruction ?? REPAIR_INSTRUCTION },
    ],
  };

  const second = await adapter.complete(repairRequest, signal);
  const secondAttempt = attemptParse(second, schema);

  if (secondAttempt.ok) {
    return { value: secondAttempt.value, result: second, attempts: 2, rawText: secondAttempt.rawText };
  }

  throw new StructuredOutputError(
    'Structured output failed twice: ' +
      `${firstAttempt.error.message} Then, after the repair retry: ${secondAttempt.error.message}`,
    secondAttempt.rawText,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ParseAttempt<T> =
  | { ok: true; value: T; rawText: string }
  | { ok: false; error: Error; rawText: string };

function attemptParse<T>(result: AgentCallResult, schema: ZodType<T>): ParseAttempt<T> {
  const rawText = selectStructuredText(result);
  try {
    return { ok: true, value: parseStructured(rawText, schema), rawText };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)), rawText };
  }
}

/** Flatten Zod issues into one line. `String()` because a path may hold a symbol. */
function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  if (issues.length === 0) return 'no issues reported';
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
