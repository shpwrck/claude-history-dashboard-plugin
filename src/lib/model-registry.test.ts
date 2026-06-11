import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_PICKER_MODELS,
  CHEAPEST_CURRENT_MODEL_ID,
  CURRENT_MODEL_IDS,
  CURRENT_RECOMMENDATION_MODEL_IDS,
  MODEL_PRICING,
  buildModelUpdateChecklist,
  resolveModelFamily,
} from './model-registry';

describe('model registry', () => {
  it('keeps current model targets in one place', () => {
    expect(CURRENT_MODEL_IDS).toEqual({
      opus: 'claude-opus-4-8',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
    });
    expect(CURRENT_RECOMMENDATION_MODEL_IDS).toEqual(CURRENT_MODEL_IDS);
    expect(CHEAPEST_CURRENT_MODEL_ID).toBe(CURRENT_MODEL_IDS.haiku);
  });

  it('derives picker options from registry metadata', () => {
    expect(ANTHROPIC_PICKER_MODELS.map((model) => model.id)).toEqual([
      CURRENT_MODEL_IDS.opus,
      CURRENT_MODEL_IDS.sonnet,
      CURRENT_MODEL_IDS.haiku,
    ]);
    expect(ANTHROPIC_PICKER_MODELS[0]).toMatchObject({
      label: 'Claude Opus 4.8',
      description: 'Most capable model. Best for complex reasoning.',
    });
  });

  it('derives exact pricing aliases from registry metadata', () => {
    expect(MODEL_PRICING['claude-opus-4-8'].input).toBe(5);
    expect(MODEL_PRICING['claude-opus-4-7'].input).toBe(5);
    expect(MODEL_PRICING['claude-opus-4-1-20250414'].input).toBe(15);
    expect(MODEL_PRICING['claude-3-haiku-20240307'].input).toBe(0.25);
  });

  it('resolves known families and leaves new family names unresolved until registered', () => {
    expect(resolveModelFamily('claude-opus-4-8')).toBe('opus');
    expect(resolveModelFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(resolveModelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(resolveModelFamily('claude-fable-1-20260609')).toBeNull();
  });

  it('builds a repeatable update checklist for an unregistered model', () => {
    expect(buildModelUpdateChecklist('claude-fable-1-20260609')).toEqual({
      modelId: 'claude-fable-1-20260609',
      registered: false,
      inferredFamily: null,
      requiredUpdates: [
        'Add authoritative model id, label, family, and picker eligibility to src/lib/model-registry.ts.',
        'Add authoritative pricing or family fallback before trusting cost estimates.',
        'Decide whether it becomes a recommendation target for trivial, moderate, or complex turns.',
        'Run scripts/model-eval-batch.mjs against baseline models before promoting it in defaults.',
      ],
    });
  });
});
