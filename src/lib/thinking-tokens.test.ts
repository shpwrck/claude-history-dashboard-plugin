import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  visibleBlockTokens,
  isThinkingBlock,
  reconstructThinkingTokens,
} from './thinking-tokens';

describe('thinking-tokens helpers (#1927)', () => {
  describe('estimateTokens', () => {
    it('uses the repo ceil(chars/4) convention', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    });
    it('treats null/undefined-ish input as 0', () => {
      expect(estimateTokens(undefined as unknown as string)).toBe(0);
    });
  });

  describe('visibleBlockTokens', () => {
    it('counts text-block prose', () => {
      expect(visibleBlockTokens({ type: 'text', text: 'abcd' })).toBe(1);
    });
    it('counts tool_use argument JSON, not the tool name', () => {
      // JSON.stringify({a:'bb'}) = '{"a":"bb"}' = 10 chars -> ceil(10/4)=3
      expect(visibleBlockTokens({ type: 'tool_use', input: { a: 'bb' } })).toBe(3);
    });
    it('returns 0 for thinking blocks (thinking text is not visible output)', () => {
      expect(visibleBlockTokens({ type: 'thinking', thinking: 'lots of reasoning' })).toBe(0);
      // The real-world shape: thinking text empty, only a signature present.
      expect(
        visibleBlockTokens({ type: 'thinking', thinking: '' } as never)
      ).toBe(0);
    });
    it('returns 0 for unknown/empty blocks', () => {
      expect(visibleBlockTokens(null)).toBe(0);
      expect(visibleBlockTokens(undefined)).toBe(0);
      expect(visibleBlockTokens({ type: 'tool_result' } as never)).toBe(0);
    });
  });

  describe('isThinkingBlock', () => {
    it('detects thinking blocks regardless of empty text', () => {
      expect(isThinkingBlock({ type: 'thinking', thinking: '' })).toBe(true);
      expect(isThinkingBlock({ type: 'text', text: 'x' })).toBe(false);
      expect(isThinkingBlock(null)).toBe(false);
    });
  });

  describe('reconstructThinkingTokens', () => {
    it('is the residual of billed output minus visible, when a thinking block is present', () => {
      expect(reconstructThinkingTokens(1000, 300, true)).toBe(700);
    });
    it('clamps at 0 so thinking + visible <= billed output (anchoring)', () => {
      expect(reconstructThinkingTokens(200, 500, true)).toBe(0);
    });
    it('is 0 when the message carried no thinking block (calibration guard)', () => {
      // A no-thinking message must not attribute its residual/overhead to thinking.
      expect(reconstructThinkingTokens(1000, 300, false)).toBe(0);
    });
  });
});
