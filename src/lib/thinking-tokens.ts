/**
 * Reconstruct an ESTIMATE of "thinking" (reasoning) tokens per assistant
 * message (#1927).
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
 * computed only for messages that actually carry a thinking block. Two
 * properties fall out for free:
 *  - Anchoring: thinking + visible <= billed output BY CONSTRUCTION (clamp at
 *    0), so the estimate can never exceed the real bill.
 *  - Conservative failure: over-counting visible only shrinks the thinking
 *    estimate toward 0 — it never inflates it.
 *
 * Messages with no thinking block must yield ~0 residual; that is the
 * calibration/honesty check (see thinking-tokens.test.ts).
 *
 * Token counts use the repo's established `ceil(chars / 4)` heuristic
 * (`repo-map/generate.ts`, `claude-context.ts`) — good enough for a share/ratio
 * estimate that is then anchored to the billed total.
 */

const CHARS_PER_TOKEN = 4;

/** Rough token count for a string, matching the repo's `ceil(chars/4)` convention. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A minimal view of one `message.content` block — only the fields we read. */
export interface VisibleBlock {
  type?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
}

/**
 * Estimated VISIBLE (billed-as-output) tokens for one content block.
 *
 * - `text` blocks: the prose itself.
 * - `tool_use` blocks: the argument JSON the model emitted (`input`), which is
 *   billed output. The tool's NAME/id is negligible and omitted.
 * - `thinking` (and anything else): 0 — thinking text is not persisted and is
 *   not "visible" output; it is exactly what the residual is meant to capture.
 */
export function visibleBlockTokens(block: VisibleBlock | null | undefined): number {
  if (!block || typeof block !== 'object') return 0;
  if (block.type === 'text') return estimateTokens(block.text ?? '');
  if (block.type === 'tool_use') {
    if (block.input === undefined || block.input === null) return 0;
    try {
      return estimateTokens(JSON.stringify(block.input));
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
 * Returns 0 when the message carried no thinking block (the residual there is
 * estimation noise / formatting overhead, not reasoning). Otherwise clamps the
 * residual at 0 so thinking + visible <= billed output always holds.
 */
export function reconstructThinkingTokens(
  outputTokens: number,
  visibleTokens: number,
  hasThinking: boolean
): number {
  if (!hasThinking) return 0;
  return Math.max(0, Math.round(outputTokens - visibleTokens));
}
