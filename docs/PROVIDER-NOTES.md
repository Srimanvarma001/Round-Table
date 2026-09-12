# Provider notes — verified against live APIs

Appendix C of `architecture.md` requires these assumptions to be verified as the
first action of milestone M5. They were checked on **2026-09-11** with the key
in `.env.local`. This file records what is actually true, and supersedes the
Appendix C table and the section 8.4 model assignment where they disagree.

**Owner decision, 2026-09-11: DeepSeek was removed.** Round Table is a
GLM-only application. Every seat, the reveal synthesis, and profile extraction
run on GLM through the single `OpenAICompatibleAdapter`. The provider table
below records what the retired DeepSeek integration returned, kept only so a
future second provider can be added without re-learning these lessons.

## 1. Model identifiers

`architecture.md` §8.4 named `deepseek-reasoner`, `deepseek-chat` and
`glm-4.6`. Those are stale. `GET /models` returns:

| Provider | Models actually served |
|---|---|
| GLM | `glm-4.5`, `glm-4.5-air`, `glm-4.6`, `glm-4.7`, `glm-5`, `glm-5-turbo`, `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash` |

**Decision.** Every seat is seeded on one model:

| Seat | Provider | Model | Reasoning requested |
|---|---|---|---|
| All eight seats, reveal synthesis, profile extraction | glm | `glm-5.3-flash` | n/a (always on) |

`reasoning` stays a per-request hint: the Me Agent and the reveal synthesis ask
for the reasoning channel, the lens seats do not — but because of section 3 the
hint has no effect on the wire.

## 2. Reasoning channel — one field name

§8.3 rule 1 predicted different field names per provider. GLM emits
`delta.reasoning_content` on streaming deltas and `message.reasoning_content`
on non-streaming responses. The adapter normalises that one field name into
`LLMDelta { kind: 'reasoning' }`.

## 3. Thinking control — the quirk that breaks naive code

This is the quirk that actually breaks naive code, and Appendix C did not
anticipate it.

**GLM cannot turn thinking off at all.** Any attempt is rejected:

```
POST {"thinking":{"type":"disabled"}} → 400 {"code":"1210",
  "message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}
```

("This model always thinks and does not support disabling thinking.")
`glm-5.3-flash` reasons on *every* request — and, critically, **`max_tokens`
covers reasoning tokens as well as answer tokens**. A 60-token request spent
all 60 on reasoning and returned `finish_reason: "length"` with empty content.

**Consequences implemented in the adapter:**

1. Requesting `reasoning: false` is a no-op, not an error. The adapter never
   sends a `thinking` block at all.
2. The adapter adds reasoning headroom to `maxTokens` so the answer is never
   starved by the thinking that precedes it
   (`GLM_REASONING_HEADROOM_TOKENS` in `openai-compatible.ts`). Without this,
   short-budget steps like `vote` return empty content on every seat.
3. `reasoning` is therefore a *hint*, exactly as `jsonMode` is. The reasoning
   drawer shows a note when a seat produced no reasoning text; it never assumes
   reasoning was requested and silently dropped.

## 4. Streaming usage

GLM honours `stream_options: { include_usage: true }` and sends a final chunk
carrying `usage` with `prompt_tokens`, `completion_tokens`, and
`completion_tokens_details.reasoning_tokens`.

§8.3 rule 2's character-based fallback is therefore rarely needed, but it is
still implemented: a stream that ends without a usage block must not leave the
budget guard with no number.

## 5. JSON mode

GLM accepts `response_format: { type: 'json_object' }` without error. It is
treated as a hint regardless, per §8.3 rule 3: `lib/llm/json.ts` extracts the
first balanced JSON object from the text and validates it with Zod, with one
repair retry.

Note that a reasoning model will happily put the JSON in the reasoning channel
and leave the content channel empty, so the extractor must read
`content_text` and fall back to `reasoning_text` only when content is empty.

## 6. Error shapes

| Situation | GLM |
|---|---|
| Bad model id / params | `400 {"error":{"code":"1210","message":"..."}}` |
| Auth failure | `401` |

A human-readable string sits under `error.message`. It is not retryable.

## 7. Pricing

`model_pricing` is seeded from the figures recorded in `scripts/seed.ts` on
2026-09-11. The budget guard is only as accurate as that table, so `/settings`
shows the last-updated date and allows a manual edit, per Appendix C.

## 8. Retired integration record (DeepSeek, removed 2026-09-11)

Kept for a future second provider. DeepSeek served `deepseek-flash` and
`deepseek-v4-pro` at `https://api.deepseek.com/v1`, honoured
`thinking: { type: 'adaptive' | 'enabled' | 'disabled' }` (with `disabled`
genuinely suppressing reasoning), emitted the same `reasoning_content` field,
and returned `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in usage.
Passing an unsupported thinking variant was a hard 400.
