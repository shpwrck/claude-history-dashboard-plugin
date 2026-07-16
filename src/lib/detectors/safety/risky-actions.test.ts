import { describe, expect, it } from 'vitest';
import { detector } from './risky-actions';
import { detectRiskyActions } from '../../parse-permissions';
import {
  deriveBashCommandSignals,
  parseToolUsage,
  type ToolCall,
  type ToolUsageData,
} from '../../parse-tools';
import type { SessionTimeline } from '../../parse-timeline';
import type { RecommendationInput } from '../types';

const ts = (i: number) => `2026-06-12T10:00:0${i}.000Z`;

function bash(id: string, command: string, index = 0): ToolCall {
  return {
    timestamp: ts(index),
    toolName: 'Bash',
    input: { command },
    toolUseId: id,
    isError: null,
    resultBytes: 0,
  };
}

function toolSession(calls: ToolCall[]): ToolUsageData {
  return { sessionId: 'session-1', calls };
}

function timeline(calls: ToolCall[]): SessionTimeline {
  return {
    sessionId: 'session-1',
    startTime: ts(0),
    endTime: ts(9),
    entries: calls.map((call) => ({
      timestamp: call.timestamp,
      kind: 'tool_use',
      toolName: 'Bash',
      toolUseId: call.toolUseId,
      summary: JSON.stringify(call.input),
    })),
  };
}

function input(calls: ToolCall[]): RecommendationInput {
  return {
    tokenData: [],
    toolData: [toolSession(calls)],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    timelines: [timeline(calls)],
  };
}

describe('safety.risky-actions (#1309)', () => {
  it('flags kubectl apply, terraform apply, and secret echo with categories and evidence refs', () => {
    const calls = [
      bash('kubectl-1', 'kubectl apply -f deploy.yaml', 1),
      bash('terraform-1', 'terraform apply -auto-approve', 2),
      bash('secret-1', 'echo "$ANTHROPIC_API_KEY"', 3),
    ];

    const found = detectRiskyActions([toolSession(calls)], [timeline(calls)]);

    expect(
      found.map((action) => ({
        pattern: action.pattern,
        category: action.category,
        severity: action.severity,
        toolUseId: action.evidenceRef?.toolUseId,
      }))
    ).toEqual([
      {
        pattern: 'kubectl mutation',
        category: 'deploy',
        severity: 'warning',
        toolUseId: 'kubectl-1',
      },
      {
        pattern: 'terraform mutation',
        category: 'production-config',
        severity: 'warning',
        toolUseId: 'terraform-1',
      },
      {
        pattern: 'secret exposure or mutation',
        category: 'secret-sensitive',
        severity: 'critical',
        toolUseId: 'secret-1',
      },
    ]);
  });

  it('does not flag read, search, or help-shaped commands', () => {
    const calls = [
      bash('grep-1', 'grep "kubectl apply" README.md', 1),
      bash('ls-1', 'ls terraform.tfstate', 2),
      bash('help-1', 'kubectl apply --help', 3),
      bash('plan-1', 'terraform plan', 4),
      bash('get-1', 'kubectl get pods', 5),
      bash('echo-1', 'echo "$NORMAL_VALUE"', 6),
    ];

    expect(detectRiskyActions([toolSession(calls)], [timeline(calls)])).toEqual([]);
  });

  it('does not claim locale-translated help or dry-run words are mutations', () => {
    const calls = [
      bash('kubectl-dry-run', 'kubectl apply $"--dry-run=client" -f deploy.yaml', 1),
      bash('kubectl-help', 'kubectl apply $"--help" -f deploy.yaml', 2),
      bash('helm-dry-run', 'helm upgrade app chart $"--dry-run"', 3),
      bash(
        'remote-heredoc',
        'ssh prod <<\'EOF\'\nkubectl apply $"--dry-run=client" -f deploy.yaml\nEOF',
        4
      ),
      bash(
        'command-substitution',
        'kubectl apply $(true; printf $"--dry-run=client") -f deploy.yaml',
        5
      ),
      bash(
        'process-substitution',
        'kubectl apply <(printf foo | cat $"--dry-run=client") -f deploy.yaml',
        6
      ),
      bash(
        'extglob-pipeline',
        'kubectl apply @(foo|#bar) $"--dry-run=client" -f deploy.yaml',
        7
      ),
      bash(
        'process-substitution-suffix',
        'kubectl apply <(printf foo)#bar $"--dry-run=client" -f deploy.yaml',
        8
      ),
      bash(
        'translated-heredoc-following-command',
        'cat <<$"EOF"\nprose\nEOF\nkubectl apply -f deploy.yaml',
        9
      ),
      bash(
        'translated-heredoc-local-body',
        'bash <<$"EOF"\nkubectl apply -f deploy.yaml\nEOF',
        10
      ),
      bash(
        'translated-heredoc-remote-body',
        'ssh prod <<$"EOF"\nkubectl apply -f deploy.yaml\nEOF',
        11
      ),
    ];

    expect(detectRiskyActions([toolSession(calls)], [timeline(calls)])).toEqual([]);
  });

  it('retains parser-proven risky attempts inside executable heredoc bodies', () => {
    const commands = [
      `bash <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod bash -s <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | bash\nkubectl apply -f deploy.yaml\nEOF`,
    ];
    const calls = commands.map((command, index) => ({
      ...bash(`heredoc-risk-${index}`, command, index + 1),
      ...deriveBashCommandSignals(command),
    }));

    expect(
      detectRiskyActions([toolSession(calls)], [timeline(calls)]).map(
        (action) => action.pattern
      )
    ).toEqual([
      'kubectl mutation',
      'kubectl mutation',
      'kubectl mutation',
    ]);
  });

  it('uses parser-owned dynamic argv truth for raw safety detection', () => {
    const queryCommands = [
      `kubectl apply "$(printf %s --dry-run=client)" -f deploy.yaml`,
      `kubectl apply $(case y in x) echo esac;; y) true;; esac)#suffix --dry-run=client -f deploy.yaml`,
      `kubectl apply "$(true # comment "\nprintf %s --dry-run=client\n)" -f deploy.yaml`,
    ];
    const queryCalls = queryCommands.map((command, index) => ({
      ...bash(`dynamic-query-${index}`, command, index + 1),
      ...deriveBashCommandSignals(command),
    }));
    expect(detectRiskyActions([toolSession(queryCalls)])).toEqual([]);

    const nested = `echo "$(kubectl apply -f missing.yaml)"`;
    const nestedCall = {
      ...bash('nested-risk', nested, 5),
      ...deriveBashCommandSignals(nested),
    };
    expect(detectRiskyActions([toolSession([nestedCall])])).toMatchObject([
      { pattern: 'kubectl mutation' },
    ]);
  });

  it('preserves parser-owned analyzed negatives on raw upload-shaped calls', () => {
    const commands = [
      'false && kubectl apply -f deploy.yaml',
      'true || terraform apply -auto-approve',
      'exit 0; kubectl delete namespace prod',
    ];
    const transcript = commands
      .map((command, index) =>
        JSON.stringify({
          type: 'assistant',
          timestamp: ts(index + 1),
          message: {
            content: [
              {
                type: 'tool_use',
                id: `dead-risk-${index}`,
                name: 'Bash',
                input: { command },
              },
            ],
          },
        })
      )
      .join('\n');
    const parsed = parseToolUsage(transcript, 'upload-shaped.jsonl')!;

    expect(
      parsed.calls.map(
        (call) =>
          (call as ToolCall & { commandAnalysisComplete?: true })
            .commandAnalysisComplete
      )
    ).toEqual([true, true, true]);
    expect(detectRiskyActions([parsed])).toEqual([]);
  });

  it('uses precomputed risky-action signals when raw command bodies are stripped', () => {
    const stripped: ToolCall = {
      ...bash('terraform-1', 'terraform apply -auto-approve', 1),
      input: {},
      commandPreview: 'terraform apply -auto-approve',
      commandRiskyActionPattern: 'terraform mutation',
    };

    expect(detectRiskyActions([toolSession([stripped])])).toMatchObject([
      {
        pattern: 'terraform mutation',
        category: 'production-config',
        command: 'terraform apply -auto-approve',
      },
    ]);
  });

  it('persists secret-sensitive evidence whose value is supplied dynamically', () => {
    const commands = [
      'echo "$GITHUB_TOKEN"',
      'echo "$ANTHROPIC_API_KEY"',
      'printf "%s" "$AWS_SECRET_ACCESS_KEY"',
      'gh secret set API_KEY --body "$VALUE"',
      'kubectl create secret generic app --from-literal=key="$VALUE"',
      'aws secretsmanager put-secret-value --secret-id app --secret-string "$VALUE"',
    ];
    const stripped = commands.map((command, index) => {
      const signals = deriveBashCommandSignals(command);
      expect(signals.commandRiskyActionPattern, command).toBe(
        'secret exposure or mutation'
      );
      return {
        ...bash(`secret-dynamic-${index}`, command, index + 1),
        ...signals,
        input: {},
      };
    });

    expect(
      detectRiskyActions([toolSession(stripped)]).map((action) => action.pattern)
    ).toEqual(commands.map(() => 'secret exposure or mutation'));
  });

  it('emits a recommendation carrying structured evidence refs', () => {
    const calls = [bash('secret-1', 'printf "%s" "$GITHUB_TOKEN"', 1)];
    const rec = detector.rule(input(calls), 0);

    expect(rec).toMatchObject({
      id: 'safety.risky-actions',
      severity: 'critical',
      evidenceRefs: [
        {
          sessionId: 'session-1',
          entryIndex: 0,
          timestamp: ts(1),
          toolUseId: 'secret-1',
        },
      ],
    });
    expect(rec?.evidence?.[0]).toContain('secret-sensitive');
  });

  it('ranks critical evidence ahead of routine publications and splits the count (#2010)', () => {
    // Three routine publications (policy-sanctioned master pushes / PR merge) at
    // earlier timestamps, one secret-sensitive action last. detectRiskyActions
    // returns them in timestamp order, so the secret is LAST in detection order —
    // the fix must rank it first so the cited evidence matches the CRITICAL driver.
    const calls = [
      bash('pub-1', 'git push origin master', 1),
      bash('pub-2', 'git push origin master', 2),
      bash('pub-3', 'gh pr merge 42 --squash', 3),
      bash('secret-1', 'echo "$ANTHROPIC_API_KEY"', 4),
    ];
    const rec = detector.rule(input(calls), 0);

    // Severity is CRITICAL because of the secret-sensitive action...
    expect(rec?.severity).toBe('critical');
    // ...and the cited evidence leads with it, not the 3 routine publications.
    expect(rec?.evidence?.[0]).toContain('secret-sensitive');
    expect(rec?.evidenceRefs?.[0]?.toolUseId).toBe('secret-1');
    // detail separates the review-worthy count from the routine publications.
    expect(rec?.detail).toContain('1 review-worthy action(s)');
    expect(rec?.detail).toContain('3 routine publication(s)');
  });

  it('emits evidence refs only for actions shown in the top-5 evidence (#2010 alignment)', () => {
    // The critical action is ranked first but its timeline entry is MISSING, so
    // it has no evidenceRef. evidence[] and evidenceRefs[] are derived from the
    // SAME top-5 slice, so a missing ref must not shift a later action's ref onto
    // an earlier evidence row — refs only ever describe shown actions.
    const calls = [
      bash('secret-1', 'echo "$ANTHROPIC_API_KEY"', 1), // critical, ranked first
      bash('pub-1', 'git push origin master', 2), // routine
    ];
    const partialTimeline: SessionTimeline = {
      sessionId: 'session-1',
      startTime: ts(0),
      endTime: ts(9),
      entries: [
        {
          timestamp: ts(2),
          kind: 'tool_use',
          toolName: 'Bash',
          toolUseId: 'pub-1', // only the routine action is in the timeline
          summary: '',
        },
      ],
    };
    const rec = detector.rule(
      {
        tokenData: [],
        toolData: [toolSession(calls)],
        sessions: [],
        projects: [],
        permissionRows: [],
        apiErrors: [],
        timelines: [partialTimeline],
      },
      0
    );

    // Critical action still ranked first in evidence, even with no ref.
    expect(rec?.evidence?.[0]).toContain('secret-sensitive');
    // The critical action (no timeline entry) contributes no ref...
    expect(rec?.evidenceRefs?.some((r) => r.toolUseId === 'secret-1')).toBe(false);
    // ...and refs only describe actions actually shown in evidence.
    const shownIds = new Set(calls.map((c) => c.toolUseId));
    for (const ref of rec?.evidenceRefs ?? []) {
      expect(shownIds.has(ref.toolUseId)).toBe(true);
    }
  });
});
