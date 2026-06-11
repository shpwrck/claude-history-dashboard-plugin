/**
 * Registry of every intentional Anthropic egress path.
 *
 * Server paths must route through `callAnthropic()` so credential class,
 * transcript-data handling, and cap checks are enforced before the network
 * call. Browser BYO-key paths are listed here for governance visibility, but
 * remain direct-from-browser and are not valid server chokepoint ids.
 */

export type LlmUsageRule = 'A' | 'B' | 'BYO';
export type LlmCredentialKind = 'oauth' | 'console-key' | 'browser-key';
export type LlmSurface = 'server' | 'browser';
export type LlmDataClass = 'none' | 'scrubbed' | 'raw-forbidden';
export type LlmTriggerKind = 'automatic' | 'opt-in' | 'user-initiated';
export type LlmEgressScrubMode = 'none' | 'stub' | 'local-model';
export type LlmWhoPays = 'operator' | 'end-user';
export type LlmTenancyBoundary = 'single' | 'per-tenant';
export type LlmPublicExposureDeployment = 'single-tenant' | 'multi-tenant';

export type LlmUsageId =
  | 'server.usage-gauge'
  | 'server.audit-judge'
  | 'browser.ask-claude';

export interface LlmCallSite {
  file: string;
  symbol: string;
}

export interface LlmUsageCaps {
  callBudget: readonly string[];
  inputBounds: readonly string[];
  spendControls: readonly string[];
}

export interface LlmExposurePolicy {
  whoPays: LlmWhoPays;
  authRequired: boolean;
  tenancyBoundary: LlmTenancyBoundary;
  publiclyReachable: boolean;
}

export interface LlmUsageEntry {
  id: LlmUsageId;
  surface: LlmSurface;
  rule: LlmUsageRule;
  callSite: LlmCallSite;
  credential: LlmCredentialKind;
  purpose: string;
  trigger: LlmTriggerKind;
  triggerDescription: string;
  dataClass: LlmDataClass;
  dataBoundary: string;
  caps: LlmUsageCaps;
  egressScrub: LlmEgressScrubMode;
  exposure: LlmExposurePolicy;
  requiredControls: readonly string[];
}

export interface LlmPublicExposureReadinessOptions {
  deployment?: LlmPublicExposureDeployment;
}

export const LLM_PHASE_1_EXPOSURE_DEFAULTS = {
  whoPays: 'operator',
  authRequired: false,
  tenancyBoundary: 'single',
  publiclyReachable: false,
} as const satisfies LlmExposurePolicy;

export const LLM_USAGE_REGISTRY: readonly LlmUsageEntry[] = [
  {
    id: 'server.usage-gauge',
    surface: 'server',
    rule: 'A',
    callSite: { file: 'scripts/server.mjs', symbol: 'handleUsage' },
    credential: 'oauth',
    purpose:
      'Read Anthropic plan-limit response headers for the live usage gauge.',
    trigger: 'opt-in',
    triggerDescription:
      'GET /api/usage when DASHBOARD_ENABLE_SERVER_USAGE_GAUGE is enabled.',
    dataClass: 'none',
    dataBoundary:
      'May use the local Claude OAuth token, but must not send ~/.claude-derived content.',
    caps: {
      callBudget: [
        'One fixed /v1/messages probe per /api/usage request.',
      ],
      inputBounds: [
        'containsClaudeData must be false',
        'request body, if present, must be the fixed max_tokens=1 probe payload',
      ],
      spendControls: [
        'DASHBOARD_ENABLE_SERVER_USAGE_GAUGE kill switch',
        'DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES bounds credential reads',
        'only parsed rate-limit headers are returned to the browser',
      ],
    },
    egressScrub: 'none',
    exposure: LLM_PHASE_1_EXPOSURE_DEFAULTS,
    requiredControls: [
      'containsClaudeData must be false',
      'request body, if present, must be a fixed probe payload',
      'only parsed rate-limit headers are returned to the browser',
    ],
  },
  {
    id: 'server.audit-judge',
    surface: 'server',
    rule: 'B',
    callSite: { file: 'scripts/server.mjs', symbol: '/api/audit.json' },
    credential: 'console-key',
    purpose:
      'Judge opt-in audit candidates and draft skill-candidate artifacts.',
    trigger: 'opt-in',
    triggerDescription:
      'GET /api/audit.json when DASHBOARD_ENABLE_SERVER_LLM_AUDITS and ANTHROPIC_API_KEY are set.',
    dataClass: 'scrubbed',
    dataBoundary:
      'May send capped, locally scrubbed audit prompts derived from dashboard data.',
    caps: {
      callBudget: [
        'DASHBOARD_AUDIT_MAX_JUDGE_CALLS bounds judge calls per /api/audit.json request',
      ],
      inputBounds: [
        'DASHBOARD_AUDIT_INPUT_MAX_ROWS caps pre-judge dataset array reads',
        'DASHBOARD_AUDIT_RESPONSE_MAX_BYTES caps serialized audit responses before compression',
        'DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS caps judge response tokens before egress',
      ],
      spendControls: [
        'DASHBOARD_ENABLE_SERVER_LLM_AUDITS kill switch',
        'ANTHROPIC_API_KEY must be explicitly configured',
        'operators should set Anthropic Console workspace spend limits',
      ],
    },
    egressScrub: 'stub',
    exposure: LLM_PHASE_1_EXPOSURE_DEFAULTS,
    requiredControls: [
      'egressScrub must run and produce a matching receipt',
      'capChecked must be true with a matching cap receipt',
      'server audit route must emit an enterprise audit event',
    ],
  },
  {
    id: 'browser.ask-claude',
    surface: 'browser',
    rule: 'BYO',
    callSite: { file: 'src/lib/claude-api.ts', symbol: 'callClaude' },
    credential: 'browser-key',
    purpose:
      'Let a user ask Claude about the currently loaded dashboard data with their own browser-held key.',
    trigger: 'user-initiated',
    triggerDescription: 'User opens Ask Claude and submits a prompt.',
    dataClass: 'raw-forbidden',
    dataBoundary:
      'The server never receives or stores the browser API key; enterprise mode can disable browser egress.',
    caps: {
      callBudget: [
        'User-initiated browser call only; no server-side fanout.',
      ],
      inputBounds: [
        'browser egress can be disabled by enterprise capability and CSP',
      ],
      spendControls: [
        'the end user provides the browser-held API key',
      ],
    },
    egressScrub: 'none',
    exposure: {
      ...LLM_PHASE_1_EXPOSURE_DEFAULTS,
      whoPays: 'end-user',
    },
    requiredControls: [
      'key stored only in browser localStorage',
      'enterprise capability can disable Ask Claude/browser egress',
      'browser CSP must opt in to Anthropic egress in enterprise mode',
    ],
  },
];

const LLM_USAGE_BY_ID = new Map(
  LLM_USAGE_REGISTRY.map((entry) => [entry.id, entry] as const)
);

export function getLlmUsageEntry(id: string): LlmUsageEntry | null {
  return LLM_USAGE_BY_ID.get(id as LlmUsageId) ?? null;
}

export function validateLlmUsageRegistry(
  entries: readonly Partial<LlmUsageEntry>[] = LLM_USAGE_REGISTRY
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const id = entry.id ?? '<missing-id>';
    if (!entry.id) {
      errors.push(`${id}: id is required`);
    } else if (seen.has(entry.id)) {
      errors.push(`${id}: duplicate registry id`);
    } else {
      seen.add(entry.id);
    }

    if (!entry.callSite?.file || !entry.callSite.symbol) {
      errors.push(`${id}: callSite.file and callSite.symbol are required`);
    }
    if (!entry.surface) errors.push(`${id}: surface is required`);
    if (!entry.rule) errors.push(`${id}: rule is required`);
    if (!entry.credential) errors.push(`${id}: credential is required`);
    if (!entry.purpose?.trim()) errors.push(`${id}: purpose is required`);
    if (!entry.trigger) errors.push(`${id}: trigger is required`);
    if (!entry.triggerDescription?.trim()) {
      errors.push(`${id}: triggerDescription is required`);
    }
    if (!entry.dataClass) errors.push(`${id}: dataClass is required`);
    if (!entry.dataBoundary?.trim()) {
      errors.push(`${id}: dataBoundary is required`);
    }
    if (!entry.requiredControls || entry.requiredControls.length === 0) {
      errors.push(`${id}: requiredControls must not be empty`);
    }
    if (!hasCaps(entry.caps)) {
      errors.push(
        `${id}: caps.callBudget/inputBounds/spendControls are required`
      );
    }
    if (!entry.exposure) {
      errors.push(`${id}: exposure policy is required`);
    } else {
      if (!entry.exposure.whoPays) {
        errors.push(`${id}: exposure.whoPays is required`);
      }
      if (typeof entry.exposure.authRequired !== 'boolean') {
        errors.push(`${id}: exposure.authRequired is required`);
      }
      if (!entry.exposure.tenancyBoundary) {
        errors.push(`${id}: exposure.tenancyBoundary is required`);
      }
      if (typeof entry.exposure.publiclyReachable !== 'boolean') {
        errors.push(`${id}: exposure.publiclyReachable is required`);
      }
    }
    if (!entry.egressScrub) errors.push(`${id}: egressScrub is required`);

    if (entry.rule === 'A') {
      if (entry.credential !== 'oauth') {
        errors.push(`${id}: Rule A requires oauth credential`);
      }
      if (entry.dataClass !== 'none') {
        errors.push(`${id}: Rule A requires dataClass none`);
      }
      if (entry.egressScrub !== 'none') {
        errors.push(`${id}: Rule A must not use egress scrub`);
      }
    }

    if (entry.rule === 'B') {
      if (entry.surface !== 'server') {
        errors.push(`${id}: Rule B must be a server surface`);
      }
      if (entry.credential !== 'console-key') {
        errors.push(`${id}: Rule B requires console-key credential`);
      }
      if (entry.dataClass !== 'scrubbed') {
        errors.push(`${id}: Rule B requires dataClass scrubbed`);
      }
      if (entry.egressScrub === 'none') {
        errors.push(`${id}: Rule B requires an egress scrub mode`);
      }
    }

    if (entry.rule === 'BYO') {
      if (entry.surface !== 'browser') {
        errors.push(`${id}: BYO entries must be browser-only`);
      }
      if (entry.credential !== 'browser-key') {
        errors.push(`${id}: BYO entries require browser-key credential`);
      }
      if (entry.egressScrub !== 'none') {
        errors.push(`${id}: BYO entries must not use server egress scrub`);
      }
    }

  }

  return uniqueErrors([
    ...errors,
    ...validateLlmPrePublicExposure(entries, {
      deployment: 'single-tenant',
    }),
  ]);
}

export function validateLlmPrePublicExposure(
  entries: readonly Partial<LlmUsageEntry>[] = LLM_USAGE_REGISTRY,
  options: LlmPublicExposureReadinessOptions = {}
): string[] {
  const deployment = options.deployment ?? 'single-tenant';
  const errors: string[] = [];

  for (const entry of entries) {
    if (!entry.exposure?.publiclyReachable) continue;

    const id = entry.id ?? '<missing-id>';
    if (!entry.exposure.authRequired) {
      errors.push(`${id}: public exposure requires authRequired=true`);
    }
    if (!hasCaps(entry.caps)) {
      errors.push(
        `${id}: public exposure requires call, input, and spend caps`
      );
    }
    if (entry.egressScrub === 'stub') {
      errors.push(`${id}: public exposure requires egressScrub other than stub`);
    }
    if (
      deployment === 'multi-tenant' &&
      entry.exposure.tenancyBoundary !== 'per-tenant'
    ) {
      errors.push(
        `${id}: multi-tenant public exposure requires tenancyBoundary=per-tenant`
      );
    }
  }

  return errors;
}

function uniqueErrors(errors: string[]): string[] {
  return Array.from(new Set(errors));
}

function hasCaps(caps: LlmUsageCaps | undefined): boolean {
  return (
    !!caps &&
    Array.isArray(caps.callBudget) &&
    caps.callBudget.length > 0 &&
    Array.isArray(caps.inputBounds) &&
    caps.inputBounds.length > 0 &&
    Array.isArray(caps.spendControls) &&
    caps.spendControls.length > 0
  );
}
