import { describe, it, expect } from 'vitest';
import {
  attributeConfigSections,
  summarizeConfigAttribution,
  DEFAULT_SIGNATURES,
  type AttributionSignature,
} from './parse-config-attribution';
import { parseConfigSet, type ConfigSection } from './parse-config-sections';
import type { ToolCall, ToolUsageData } from './parse-tools';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CLAUDE_MD = `# Project conventions

## Build & deploy

Build with \`npx vite build\`, not \`npm run build\` (which runs \`tsc -b\`).

## Working effectively

Run /recs at the start of a task.
`;

const AGENTS_MD = `# Conventions

## External data shapes

See REFERENCES.md before reverse-engineering a \`src/lib/parse-sessions.ts\` parser.

## Native tools

Prefer native Read/Grep over Bash grep and cat.
`;

const SECTIONS: ConfigSection[] = parseConfigSet([
  { scope: 'CLAUDE.md', content: CLAUDE_MD },
  { scope: 'AGENTS.md', content: AGENTS_MD },
]);

function sectionByHeading(heading: string): ConfigSection {
  const s = SECTIONS.find((x) => x.heading === heading);
  if (!s) throw new Error(`fixture missing section: ${heading}`);
  return s;
}

let uid = 0;
function call(
  toolName: string,
  input: ToolCall['input'],
  timestamp = '',
): ToolCall {
  uid += 1;
  return {
    timestamp,
    toolName,
    input,
    toolUseId: `t${uid}`,
    isError: null,
    resultBytes: 0,
  };
}

function session(sessionId: string, calls: ToolCall[]): ToolUsageData {
  return { sessionId, calls };
}

const T1 = '2026-06-09T10:00:00.000Z';
const T2 = '2026-06-09T10:01:00.000Z';

// A corpus exercising all three signatures.
const TOOL_DATA: ToolUsageData[] = [
  session('build-ok', [call('Bash', { command: 'npx vite build' })]),
  session('build-bad', [call('Bash', { command: 'npm run build' })]),
  session('native', [
    call('Grep', {}),
    call('Bash', { command: 'grep -r foo src/' }),
    call('Bash', { command: 'cat src/lib/parse-tools.ts' }),
  ]),
  session('pin-ok', [
    call('Read', { file_path: 'REFERENCES.md' }, T1),
    call('Read', { file_path: 'src/lib/parse-sessions.ts' }, T2),
  ]),
  session('pin-bad', [
    call('Read', { file_path: 'src/lib/parse-timeline.ts' }, T1),
  ]),
];

// ── Section ↔ signature matching ──────────────────────────────────────────────

describe('signature matching', () => {
  it('maps the Build & deploy section to the build-command signature', () => {
    const [report] = attributeConfigSections([sectionByHeading('Build & deploy')], {
      toolData: TOOL_DATA,
    });
    expect(report.signatureClass).toBe('build-command');
    expect(report.signatureId).toBe('build-command/vite-not-tsc');
  });

  it('maps the Native tools section to the native-tool signature', () => {
    const [report] = attributeConfigSections([sectionByHeading('Native tools')], {
      toolData: TOOL_DATA,
    });
    expect(report.signatureClass).toBe('native-tool');
  });

  it('maps the External data shapes section (REFERENCES.md ref) to key-file-pin', () => {
    const [report] = attributeConfigSections(
      [sectionByHeading('External data shapes')],
      { toolData: TOOL_DATA },
    );
    expect(report.signatureClass).toBe('key-file-pin');
    expect(report.signatureId).toBe('key-file-pin/references-before-parsers');
  });
});

// ── Class 1: build-command ─────────────────────────────────────────────────────

describe('build-command signature', () => {
  it('counts prescribed vs forbidden Bash commands across sessions', () => {
    const [report] = attributeConfigSections([sectionByHeading('Build & deploy')], {
      toolData: TOOL_DATA,
    });
    expect(report.attributability).toBe('attributable');
    expect(report.observation).not.toBeNull();
    // `npx vite build` compliant, `npm run build` violating.
    expect(report.observation!.compliant).toBe(1);
    expect(report.observation!.violating).toBe(1);
    expect(report.observation!.complianceRate).toBeCloseTo(0.5);
    expect(report.observation!.sessions).toBe(2);
  });
});

// ── Class 2: native-tool ───────────────────────────────────────────────────────

describe('native-tool signature', () => {
  it('scores native Grep/Glob against Bash grep/find/cat', () => {
    const [report] = attributeConfigSections([sectionByHeading('Native tools')], {
      toolData: TOOL_DATA,
    });
    expect(report.attributability).toBe('attributable');
    // 1 native Grep compliant; 1 Bash grep + 1 cat violating.
    expect(report.observation!.compliant).toBe(1);
    expect(report.observation!.violating).toBe(2);
    expect(report.observation!.complianceRate).toBeCloseTo(1 / 3);
    expect(report.observation!.sessions).toBe(1);
  });
});

// ── Class 3: key-file-pin ──────────────────────────────────────────────────────

describe('key-file-pin signature', () => {
  it('credits sessions that read the pin before the governed file', () => {
    const [report] = attributeConfigSections(
      [sectionByHeading('External data shapes')],
      { toolData: TOOL_DATA },
    );
    expect(report.attributability).toBe('attributable');
    // pin-ok read REFERENCES.md before parse-sessions.ts; pin-bad did not.
    expect(report.observation!.compliant).toBe(1);
    expect(report.observation!.violating).toBe(1);
    expect(report.observation!.sessions).toBe(2);
  });

  it('does not score sessions that never touch a governed file', () => {
    const [report] = attributeConfigSections(
      [sectionByHeading('External data shapes')],
      { toolData: [session('unrelated', [call('Bash', { command: 'ls' })])] },
    );
    expect(report.attributability).toBe('unattributable');
    expect(report.observation).toBeNull();
  });
});

// ── Falsifiability classification ──────────────────────────────────────────────

describe('attributability classification', () => {
  it('reports unattributable when a matched signature has no observed events', () => {
    const [report] = attributeConfigSections([sectionByHeading('Build & deploy')], {
      toolData: [], // no Bash build commands anywhere
    });
    expect(report.signatureClass).toBe('build-command');
    expect(report.attributability).toBe('unattributable');
    expect(report.observation).toBeNull();
  });

  it('reports unfalsifiable when no signature class applies', () => {
    const [report] = attributeConfigSections(
      [sectionByHeading('Working effectively')],
      { toolData: TOOL_DATA },
    );
    expect(report.attributability).toBe('unfalsifiable');
    expect(report.signatureId).toBeNull();
    expect(report.signatureClass).toBeNull();
    expect(report.observation).toBeNull();
  });
});

// ── Evidence honesty (#726) ─────────────────────────────────────────────────────

describe('evidence labelling', () => {
  it('labels every report tier-0-estimate (heuristic, never causal)', () => {
    const reports = attributeConfigSections(SECTIONS, { toolData: TOOL_DATA });
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      expect(r.evidence).toBe('tier-0-estimate');
      // No causal/realized-savings field is ever emitted from this slice.
      if (r.observation) {
        expect(r.observation).not.toHaveProperty('realizedSavingsUsd');
        if (r.observation.complianceRate !== null) {
          expect(r.observation.complianceRate).toBeGreaterThanOrEqual(0);
          expect(r.observation.complianceRate).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// ── Summary roll-up ─────────────────────────────────────────────────────────────

describe('summarizeConfigAttribution', () => {
  it('counts sections by attributability', () => {
    const reports = attributeConfigSections(SECTIONS, { toolData: TOOL_DATA });
    const summary = summarizeConfigAttribution(reports);
    expect(summary.attributable + summary.unattributable + summary.unfalsifiable).toBe(
      reports.length,
    );
    // Build & deploy, Native tools, External data shapes are all attributable
    // with this corpus.
    expect(summary.attributable).toBe(3);
    // The preamble + "Working effectively" have no signature.
    expect(summary.unfalsifiable).toBeGreaterThanOrEqual(2);
  });
});

// ── Framework genericity (catalog is data, not hardcoded) ───────────────────────

describe('custom signature catalog', () => {
  it('evaluates a caller-supplied signature instead of the defaults', () => {
    const custom: AttributionSignature[] = [
      {
        id: 'build-command/custom',
        describe: 'custom rule',
        match: { heading: /Working effectively/ },
        params: {
          class: 'build-command',
          prescribed: /\bnpx vite build\b/,
          forbidden: /\bnpm run build\b/,
        },
      },
    ];
    const [report] = attributeConfigSections(
      [sectionByHeading('Working effectively')],
      { toolData: TOOL_DATA },
      custom,
    );
    // With the custom catalog the otherwise-unfalsifiable section now matches.
    expect(report.signatureId).toBe('build-command/custom');
    expect(report.attributability).toBe('attributable');
  });

  it('ships exactly the three documented signature classes by default', () => {
    const classes = new Set(DEFAULT_SIGNATURES.map((s) => s.params.class));
    expect(classes).toEqual(
      new Set(['build-command', 'native-tool', 'key-file-pin']),
    );
  });
});
