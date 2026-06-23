/**
 * Reconstruct an ESTIMATE of "thinking" (reasoning) tokens per assistant
 * message (#1927; recalibrated #2006).
 *
 * Why an estimate, and why a residual: the `usage` object the API returns has
 * **no** thinking/reasoning token field — `output_tokens` lumps thinking and
 * visible output together. The transcript DOES carry `thinking` content blocks,
 * but their **text is not persisted**: in practice the `.thinking` field is
 * empty and the block holds only an encrypted `signature` (whose length does
 * not track thinking-token count). So thinking cannot be reconstructed by
 * tokenizing thinking text — there is nothing to tokenize.
 *
 * What IS present and tokenizable is the VISIBLE output: `text` blocks and the
 * `tool_use` argument JSON. So we estimate thinking as the residual of the
 * billed output after subtracting the tokenizable visible output:
 *
 *   thinkingTokens(msg) ≈ max(0, billed_output_tokens − est(visible))
 *
 * computed only for messages that actually carry a thinking block. Anchoring:
 * thinking + visible <= billed output BY CONSTRUCTION (clamp at 0), so the
 * estimate can never exceed the real bill.
 *
 * CALIBRATION (#2006). The token counts are NOT the repo's generic `ceil(chars/4)`:
 * validating against the no-thinking control group (a message with no thinking
 * block must yield residual ≈ 0) over the full local corpus showed `chars/4`
 * badly under-counts visible output — assistant text runs ~2.6 chars/token and
 * `tool_use` argument JSON ~1.7 chars/token (dense), not 4. Using 4 inflated the
 * residual and over-attributed to thinking (corpus aggregate fell 62.6%→44.5%
 * after recalibration). The divisors below are the measured per-block-type
 * control-group medians.
 *
 * Precision caveat: the chars↔token relationship has large irreducible
 * per-message variance (tool_use inputs span ~0→500 chars/token), so NO single
 * divisor yields per-message accuracy — even recalibrated, only ~18% of control
 * messages land within ±20% of billed. The divisors are tuned so the POSITIVE
 * (false-thinking) residual tail is small (control p99 ≈ +107 tokens); the
 * residual otherwise skews toward over-counting visible, which is the safe
 * direction because `reconstructThinkingTokens` clamps at 0. Net: a conservative
 * corpus-directional LOWER BOUND, not a per-message truth. Tight per-message
 * accuracy would require a real BPE tokenizer (deferred, see #2006).
 *
 * KNOWN LIMIT — under-count when no thinking block is present. Reasoning-heavy
 * turns that end in a small/no-arg tool call frequently carry NO thinking block
 * (interleaved thinking that Claude Code does not persist; e.g. a `get_me` call
 * with `input:{}` that still billed ~1800 output tokens). Those score 0 here
 * because we only attribute thinking with positive evidence (a block). So this
 * is a corpus-directional LOWER BOUND, not a per-session ground truth.
 */

// Measured control-group medians (#2006), not the generic 4 chars/token.
const TEXT_CHARS_PER_TOKEN = 2.6;
const TOOL_USE_CHARS_PER_TOKEN = 1.7;

/** Rough token count for a string at the given chars/token density. */
export function estimateTokens(
  text: string,
  charsPerToken: number = TEXT_CHARS_PER_TOKEN
): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/** A minimal view of one `message.content` block — only the fields we read. */
export interface VisibleBlock {
  type?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
}

/**
 * Estimated VISIBLE (billed-as-output) tokens for one content block, using the
 * per-block-type density calibrated in #2006.
 *
 * - `text` blocks: the prose itself (~2.6 chars/token).
 * - `tool_use` blocks: the argument JSON the model emitted (`input`), which is
 *   billed output and tokenizes denser (~1.7 chars/token). The tool's NAME/id
 *   is negligible and omitted.
 * - `thinking` (and anything else): 0 — thinking text is not persisted and is
 *   not "visible" output; it is exactly what the residual is meant to capture.
 */
export function visibleBlockTokens(block: VisibleBlock | null | undefined): number {
  if (!block || typeof block !== 'object') return 0;
  if (block.type === 'text') return estimateTokens(block.text ?? '', TEXT_CHARS_PER_TOKEN);
  if (block.type === 'tool_use') {
    if (block.input === undefined || block.input === null) return 0;
    try {
      return estimateTokens(JSON.stringify(block.input), TOOL_USE_CHARS_PER_TOKEN);
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Whether a content block is a thinking/reasoning block. */
export function isThinkingBlock(block: VisibleBlock | null | undefined): boolean {
  return !!block && typeof block === 'object' && block.type === 'thinking';
}

/**
 * Reconstruct the per-message thinking-token estimate from the billed output
 * total and the summed visible-token estimate.
 *
 * Returns 0 when the message carried no thinking block (we only attribute
 * thinking with positive evidence — see the KNOWN LIMIT note above). Otherwise
 * clamps the residual at 0 so thinking + visible <= billed output always holds.
 */
export function reconstructThinkingTokens(
  outputTokens: number,
  visibleTokens: number,
  hasThinking: boolean
): number {
  if (!hasThinking) return 0;
  return Math.max(0, Math.round(outputTokens - visibleTokens));
}
