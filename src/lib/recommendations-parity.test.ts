/**
 * Parity snapshot — the golden record proving the 20 legacy RULES port into the
 * Detector Catalog (#507) BYTE-IDENTICALLY.
 *
 * Generated from the PRE-port code (legacy in-file rules) and frozen. After the
 * port, `buildRecommendations` on the same rich input MUST reproduce this
 * snapshot WITHOUT `vitest -u`. A drifting detector is a port bug — fix the
 * detector to match the original; never regenerate the snapshot to pass.
 *
 * The single input below is engineered to trigger a broad spread of rules across
 * cost / context / workflow / safety / reliability / activity so the snapshot
 * exercises as many ported bodies as possible at once.
 */
import { describe, it, expect } from 'vitest';
import { buildRecommendations, type RecommendationInput } from './recommendations';
import type { ToolCall, ToolUsageData } from './parse-tools';
import type {
  SessionTokenData,
  TokenEntry,
  ProjectStats,
  AssistantFeatures,
  LiveConfig,
} from '../types';

const bashCall = (command: string, isError: boolean | null = null): ToolCall => ({
  timestamp: 't',
  toolName: 'Bash',
  input: { command },
  toolUseId: 'u',
  isError,
  resultBytes: 0,
});

const namedCall = (
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean | null = null
): ToolCall => ({
  timestamp: 't',
  toolName,
  input,
  toolUseId: 'u',
  isError,
  resultBytes: 0,
});

const toolSession = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({
  sessionId,
  calls,
});

const entry = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  extra: Partial<TokenEntry> = {}
): TokenEntry => ({
  timestamp: 't',
  inputTokens,
  outputTokens,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model,
  ...extra,
});

const tokenSession = (
  sessionId: string,
  entrypoint: string | undefined,
  entries: TokenEntry[],
  extra: Partial<SessionTokenData> = {}
): SessionTokenData =>
  ({
    sessionId,
    entrypoint,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
    ...extra,
  }) as unknown as SessionTokenData;

const project = (over: Partial<ProjectStats>): ProjectStats =>
  ({
    project: '/repo/x',
    projectShort: 'x',
    sessionCount: 5,
    messageCount: 100,
    firstSeen: 0,
    lastSeen: 0,
    sessions: [],
    ...over,
  }) as ProjectStats;

const features = (over: Partial<AssistantFeatures>): AssistantFeatures => ({
  sessionId: 's',
  assistantTurnCount: 0,
  textLength: 0,
  codeBlockCount: 0,
  toolCallCount: 0,
  refusalCount: 0,
  hedgingCount: 0,
  endsWithQuestionCount: 0,
  thinkingByteLen: 0,
  ...over,
});

describe('recommendations parity snapshot (#507)', () => {
  it('byte-identical buildRecommendations output for a broad-spread input', () => {
    const now = 1_700_000_000_000;
    const stale = now - 6 * 7 * 24 * 60 * 60 * 1000;

    // Native-tool bypass via grep/find/cat Bash calls (≥10 to clear the gate),
    // repeated commands (same command 3+ times), and a churned file via repeated
    // Edit/Write, plus error-prone tool calls and a retry storm.
    const editChurn: ToolCall[] = [];
    for (let i = 0; i < 18; i++) {
      editChurn.push(namedCall('Edit', { file_path: '/repo/x/churn.ts' }, false));
    }
    const erroringReads: ToolCall[] = [];
    for (let i = 0; i < 8; i++) {
      erroringReads.push(namedCall('Read', { file_path: '/repo/x/missing.ts' }, i < 6));
    }
    const retryStorm: ToolCall[] = [];
    for (let i = 0; i < 6; i++) {
      retryStorm.push(namedCall('Grep', { pattern: 'foo' }, true));
    }

    const automationSession = toolSession('automate', [
      bashCall('grep -r foo .'),
      bashCall('grep -r bar .'),
      bashCall('grep -r baz .'),
      bashCall('find . -name "*.ts"'),
      bashCall('find . -name "*.js"'),
      bashCall('cat package.json'),
      bashCall('cat tsconfig.json'),
      bashCall('cat README.md'),
      bashCall('grep -r qux .'),
      bashCall('find . -name "*.json"'),
      bashCall('grep -r quux .'),
      bashCall('cat src/index.ts'),
      // repeated identical command 3+ times
      bashCall('npm run build'),
      bashCall('npm run build'),
      bashCall('npm run build'),
      bashCall('npm run build'),
      // dangerous command under bypass + unattended entrypoint. Use a
      // catastrophic target (`~`): scoped/reversible rm -rf is now medium-
      // certainty and gated out of the safety findings (#2011), so the corpus
      // must use an unscoped target to keep exercising the safety rule.
      bashCall('rm -rf ~'),
      bashCall('git reset --hard HEAD'),
      ...editChurn,
      ...erroringReads,
      ...retryStorm,
    ]);

    // Redundant reads: same file Read 3+ times in one session.
    const readSession = toolSession('reader', [
      namedCall('Read', { file_path: '/repo/x/conf.ts' }, false),
      namedCall('Read', { file_path: '/repo/x/conf.ts' }, false),
      namedCall('Read', { file_path: '/repo/x/conf.ts' }, false),
      namedCall('Read', { file_path: '/repo/x/conf.ts' }, false),
    ]);

    const input: RecommendationInput = {
      // Automation spend on a top-tier model + 1h cache waste + unknown model.
      tokenData: [
        tokenSession('automate', 'sdk-cli', [
          entry('claude-opus-4-8', 6_000_000, 1_200_000, {
            cacheCreationTokens: 4_000_000,
            cacheCreation1hTokens: 4_000_000,
          }),
        ]),
        tokenSession('reader', 'cli', [
          entry('claude-opus-4-8', 1_000_000, 200_000),
        ]),
        tokenSession('mystery', 'cli', [entry('some-unknown-model', 500_000, 100_000)], {
          hasUnknownModel: true,
        }),
        tokenSession('extra1', 'cli', [entry('claude-opus-4-8', 100_000, 20_000)]),
        tokenSession('extra2', 'cli', [entry('claude-opus-4-8', 100_000, 20_000)]),
      ],
      toolData: [automationSession, readSession],
      sessions: [],
      // Stale project with real history.
      projects: [
        project({
          project: '/repo/stale',
          projectShort: 'stale',
          sessionCount: 5,
          lastSeen: stale,
        }),
      ],
      // Bypass mode on the automation session.
      permissionRows: [{ mode: 'bypassPermissions', sessionId: 'automate' }],
      // API errors including a 429 rate limit.
      apiErrors: [
        { sessionId: 'automate', status: 429, timestamp: 't', message: 'rate limited' },
        { sessionId: 'automate', status: 500, timestamp: 't', message: 'server error' },
      ] as unknown as RecommendationInput['apiErrors'],
      // deny-never-triggered + allow-overlaps-deny via live settings permissions.
      liveConfig: {
        settings: {
          permissions: {
            allow: ['Bash(npm test:*)'],
            deny: ['Bash(npm test:*)', 'Bash(yarn install:*)'],
          },
        },
        claudeMd: { global: null, perProject: {} },
        plugins: [],
        mcpServers: [],
        skills: [],
        subagents: [],
        commands: [],
      } as unknown as LiveConfig,
      // High refusal rate to trigger the assistant-refusal rule.
      assistantFeatures: [
        features({
          sessionId: 'automate',
          assistantTurnCount: 100,
          refusalCount: 30,
        }),
      ],
    };

    expect(buildRecommendations(input, now)).toMatchSnapshot();
  });
});
