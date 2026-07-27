export type RoutingModelFamily = 'opus' | 'sonnet' | 'haiku';
export type ModelFamily = RoutingModelFamily | 'fable' | 'mythos';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface AnthropicPickerModel {
  id: string;
  label: string;
  description: string;
}

interface ModelRegistryEntry {
  id: string;
  family: ModelFamily;
  pricing: ModelPricing;
  label?: string;
  description?: string;
  picker?: boolean;
  aliases?: readonly string[];
}

function tier(baseInput: number): ModelPricing {
  return {
    input: baseInput,
    output: baseInput * 5,
    cacheWrite5m: baseInput * 1.25,
    cacheWrite1h: baseInput * 2,
    cacheRead: baseInput * 0.1,
  };
}

export const CURRENT_MODEL_IDS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
} as const satisfies Record<RoutingModelFamily, string>;

export const CURRENT_RECOMMENDATION_MODEL_IDS = CURRENT_MODEL_IDS;

export const CHEAPEST_CURRENT_MODEL_ID = CURRENT_MODEL_IDS.haiku;

const OPUS_CURRENT = tier(5);
const SONNET_CURRENT = tier(3);
const HAIKU_CURRENT = tier(1);
const FABLE_CURRENT = tier(10);
const MYTHOS_CURRENT = tier(10);
const OPUS_LEGACY = tier(15);
const SONNET_LEGACY = tier(3);
const HAIKU_35 = tier(0.8);
const OPUS_3 = tier(15);
const SONNET_3 = tier(3);
const HAIKU_3 = tier(0.25);

export const CURRENT_FAMILY_PRICING = {
  fable: FABLE_CURRENT,
  mythos: MYTHOS_CURRENT,
  opus: OPUS_CURRENT,
  sonnet: SONNET_CURRENT,
  haiku: HAIKU_CURRENT,
} as const satisfies Record<ModelFamily, ModelPricing>;

const MODEL_REGISTRY: readonly ModelRegistryEntry[] = [
  {
    id: 'claude-fable-5',
    family: 'fable',
    pricing: FABLE_CURRENT,
    label: 'Claude Fable 5',
    description: 'Most capable widely released model for long-horizon agentic work.',
  },
  {
    id: 'claude-mythos-5',
    family: 'mythos',
    pricing: MYTHOS_CURRENT,
    label: 'Claude Mythos 5',
    description: 'Limited-availability Mythos-class model.',
  },
  {
    id: CURRENT_MODEL_IDS.opus,
    family: 'opus',
    pricing: OPUS_CURRENT,
    picker: true,
    label: 'Claude Opus 4.8',
    description: 'Most capable model. Best for complex reasoning.',
    aliases: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20250620'],
  },
  {
    // Claude Opus 5: registered but NOT the default Opus — CURRENT_MODEL_IDS.opus
    // stays claude-opus-4-8 and this is left out of the picker. Priced at the
    // current Opus tier ($5 in / $25 out per MTok), same as Opus 4.8, per
    // https://www.anthropic.com/news/claude-opus-5 (verified 2026-07-24).
    id: 'claude-opus-5',
    family: 'opus',
    pricing: OPUS_CURRENT,
  },
  {
    id: CURRENT_MODEL_IDS.sonnet,
    family: 'sonnet',
    pricing: SONNET_CURRENT,
    picker: true,
    label: 'Claude Sonnet 5',
    description: 'Most agentic Sonnet yet; balances capability and speed.',
    aliases: ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250514', 'claude-sonnet-4-5-20250929'],
  },
  {
    id: CURRENT_MODEL_IDS.haiku,
    family: 'haiku',
    pricing: HAIKU_CURRENT,
    picker: true,
    label: 'Claude Haiku 4.5',
    description: 'Fastest, lowest cost. Great for short tasks.',
  },
  {
    id: 'claude-opus-4-1-20250414',
    family: 'opus',
    pricing: OPUS_LEGACY,
    aliases: ['claude-opus-4-20250115'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    family: 'sonnet',
    pricing: SONNET_LEGACY,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    family: 'sonnet',
    pricing: SONNET_CURRENT,
    aliases: ['claude-3-5-sonnet-20240620'],
  },
  {
    id: 'claude-3-5-haiku-20241022',
    family: 'haiku',
    pricing: HAIKU_35,
  },
  {
    id: 'claude-3-opus-20240229',
    family: 'opus',
    pricing: OPUS_3,
  },
  {
    id: 'claude-3-sonnet-20240229',
    family: 'sonnet',
    pricing: SONNET_3,
  },
  {
    id: 'claude-3-haiku-20240307',
    family: 'haiku',
    pricing: HAIKU_3,
  },
];

export const ANTHROPIC_PICKER_MODELS = MODEL_REGISTRY
  .filter((model) => model.picker)
  .map((model) => ({
    id: model.id,
    label: model.label ?? model.id,
    description: model.description ?? '',
  })) as readonly AnthropicPickerModel[];

export const MODEL_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  MODEL_REGISTRY.flatMap((model) => [
    [model.id, model.pricing],
    ...(model.aliases ?? []).map((alias) => [alias, model.pricing] as const),
  ])
);

export function resolveModelFamily(model: string): ModelFamily | null {
  const exact = MODEL_REGISTRY.find(
    (entry) => entry.id === model || entry.aliases?.includes(model)
  );
  if (exact) return exact.family;

  const lower = model.toLowerCase();
  if (lower.includes('fable')) return 'fable';
  if (lower.includes('mythos')) return 'mythos';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

export interface ModelUpdateChecklist {
  modelId: string;
  registered: boolean;
  inferredFamily: ModelFamily | null;
  requiredUpdates: string[];
}

export function buildModelUpdateChecklist(modelId: string): ModelUpdateChecklist {
  const registered = Object.prototype.hasOwnProperty.call(MODEL_PRICING, modelId);
  const inferredFamily = resolveModelFamily(modelId);
  return {
    modelId,
    registered,
    inferredFamily,
    requiredUpdates: registered
      ? [
          'Confirm picker eligibility and default-model impact in src/lib/model-registry.ts.',
          'Run scripts/model-eval-batch.mjs against baseline models before promoting it in defaults.',
        ]
      : [
          'Add authoritative model id, label, family, and picker eligibility to src/lib/model-registry.ts.',
          'Add authoritative pricing or family fallback before trusting cost estimates.',
          'Decide whether it becomes a recommendation target for trivial, moderate, or complex turns.',
          'Run scripts/model-eval-batch.mjs against baseline models before promoting it in defaults.',
        ],
  };
}
