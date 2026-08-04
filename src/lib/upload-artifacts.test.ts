import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectUploadArtifacts } from './upload-artifacts';
import { analyzeReliability, parseTelemetryDir } from './parse-telemetry';
import type { LoadedFile } from './unzip-upload';

describe('collectUploadArtifacts (#1051)', () => {
  it('parses current upload artifacts into the App dataset slices', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    const metadata = Buffer.from(JSON.stringify({ attempt: 3, elapsed_ms: 30001 })).toString('base64');
    const latencyMetadata = Buffer.from(JSON.stringify({
      last_session_api_duration: 17_906,
      last_session_tool_duration: 2_417,
      last_session_total_input_tokens: 4_002,
      last_session_total_output_tokens: 931,
    })).toString('base64');
    const files: LoadedFile[] = [
      {
        name: '1.json',
        path: 'tasks/sess-1/1.json',
        text: JSON.stringify({ id: '1', subject: 'Fix upload', status: 'pending', blockedBy: ['0'] }),
        lastModified: now - 60_000,
      },
      {
        name: 'agent.json',
        path: 'teams/t1/inboxes/agent.json',
        text: JSON.stringify([
          {
            from: 'lead',
            text: JSON.stringify({ type: 'task_assignment', taskId: 't1', subject: 'Investigate' }),
            timestamp: '2026-06-10T11:00:00Z',
            type: 'message',
            read: false,
          },
        ]),
      },
      {
        name: '123.json',
        path: 'sessions/123.json',
        text: JSON.stringify({
          pid: 123,
          sessionId: 'sess-1',
          cwd: '/repo',
          startedAt: now - 120_000,
          procStart: '99',
          version: '2.1.1',
          peerProtocol: 1,
          kind: 'interactive',
          entrypoint: 'sdk-cli',
        }),
      },
      {
        name: '1p_failed_events.json',
        path: 'telemetry/1p_failed_events.json',
        text: JSON.stringify({
          event_data: {
            event_name: 'tengu_api_slow_first_byte',
            client_timestamp: '2026-06-10T11:01:00Z',
            model: 'claude-opus-4-7',
            betas: '',
            session_id: 'sess-1',
            additional_metadata: metadata,
            env: { node_version: 'v24', terminal: 'xterm', arch: 'x64' },
            email: 'secret@example.com',
          },
        }) + '\n' + JSON.stringify({
          event_data: {
            event_name: 'tengu_exit',
            client_timestamp: '2026-06-10T11:02:00Z',
            model: 'claude-opus-4-8[1m]',
            betas: '',
            session_id: 'sess-1',
            additional_metadata: latencyMetadata,
          },
        }) + '\n',
      },
      {
        name: 'sess-1.txt',
        path: 'debug/sess-1.txt',
        text:
          '2026-06-10T11:00:00.000Z [API REQUEST] /v1/messages source=sdk\n' +
          '2026-06-10T11:00:01.000Z Stream started - received first chunk\n',
      },
      {
        name: 'stats-cache.json',
        path: 'stats-cache.json',
        text: JSON.stringify({
          version: 3,
          lastComputedDate: '2026-06-10',
          dailyActivity: [{ date: '2026-06-10', messageCount: 1, sessionCount: 1, toolCallCount: 2 }],
        }),
      },
      {
        name: 'snapshot@v2',
        path: 'file-history/sess-1/snapshot@v2',
        text: '',
        metadataOnly: true,
        lastModified: now - 30_000,
      },
      {
        name: 'plan.md',
        path: 'plans/plan.md',
        text: '## Work\n1. src/App.tsx\n## Verification\nRun tests',
      },
      {
        name: '.last-update-result.json',
        path: '.last-update-result.json',
        text: JSON.stringify({ timestamp: '2026-06-10T10:00:00Z', outcome: 'success' }),
      },
      {
        name: 'mcp-needs-auth-cache.json',
        path: 'mcp-needs-auth-cache.json',
        text: JSON.stringify({ github: { needsAuth: true, reason: 'expired' } }),
      },
    ];

    const artifacts = collectUploadArtifacts(files, { nowMs: now });

    expect(artifacts.tasks).toHaveLength(1);
    expect(artifacts.tasks[0].subject).toBe('Fix upload');
    expect(artifacts.teams).toHaveLength(1);
    expect(artifacts.teams[0].droppedCount).toBe(1);
    expect(artifacts.sessionRegistry[0].entrypoint).toBe('sdk-cli');
    expect(artifacts.telemetry[0]).toMatchObject({ attempt: 3, elapsed_ms: 30001 });
    expect(artifacts.modelLatency[0]).toMatchObject({
      apiDurationMs: 17_906,
      outputTokens: 931,
      model: 'claude-opus-4-8[1m]',
    });
    expect(JSON.stringify(artifacts.telemetry)).not.toContain('secret@example.com');
    expect(artifacts.debugLogs[0].ttfbP50).toBe(1000);
    expect(artifacts.statsCache?.dailyActivity[0].toolCallCount).toBe(2);
    expect(artifacts.fileHistory[0].churn).toBe(1);
    expect(artifacts.plans[0]).toMatchObject({ id: 'plan', hasVerification: true });
    expect(artifacts.updateResults[0].outcome).toBe('success');
    expect(artifacts.mcpAuth?.serversNeedingAuth).toEqual(['github']);
  });

  it('drops non-slow-first-byte telemetry so the upload matches server-side reliability metrics (#3613)', () => {
    // A bundle whose telemetry/1p_failed_events.json carries ONE slow-first-byte
    // failure and ONE tengu_exit line. The upload parser must drop the tengu_exit
    // from the reliability slice exactly as the server-side parseTelemetryDir
    // does — otherwise the #3159 dilution returns (totalEvents inflated,
    // retryStormPct depressed) once App.tsx replaces the correctly-filtered
    // server telemetry with these upload events.
    const failMeta = Buffer.from(
      JSON.stringify({ attempt: 5, elapsed_ms: 30001 }),
    ).toString('base64');
    const exitMeta = Buffer.from(
      JSON.stringify({ last_session_api_duration: 12345 }),
    ).toString('base64');
    const ndjson =
      JSON.stringify({
        event_data: {
          event_name: 'tengu_api_slow_first_byte',
          client_timestamp: '2026-06-10T11:01:00Z',
          model: 'claude-opus-4-8[1m]',
          betas: '',
          session_id: 'sess-mix',
          additional_metadata: failMeta,
        },
      }) +
      '\n' +
      JSON.stringify({
        event_data: {
          event_name: 'tengu_exit',
          client_timestamp: '2026-06-10T11:02:00Z',
          model: 'claude-opus-4-8[1m]',
          betas: '',
          session_id: 'sess-mix',
          additional_metadata: exitMeta,
        },
      }) +
      '\n';

    const files: LoadedFile[] = [
      { name: '1p_failed_events.json', path: 'telemetry/1p_failed_events.json', text: ndjson },
    ];
    const artifacts = collectUploadArtifacts(files);

    // Upload reliability slice: exactly the one slow-first-byte event.
    expect(artifacts.telemetry).toHaveLength(1);
    expect(artifacts.telemetry[0].event_name).toBe('tengu_api_slow_first_byte');
    const uploadReliability = analyzeReliability(artifacts.telemetry);
    expect(uploadReliability.totalEvents).toBe(1);
    expect(uploadReliability.retryStormPct).toBe(100); // the single attempt-5 storm

    // Server-side parse of the SAME corpus yields identical reliability metrics.
    const dir = mkdtempSync(join(tmpdir(), 'upload-telemetry-3613-'));
    try {
      writeFileSync(join(dir, '1p_failed_events.json'), ndjson);
      const serverReliability = analyzeReliability(parseTelemetryDir(dir));
      expect(serverReliability.totalEvents).toBe(uploadReliability.totalEvents);
      expect(serverReliability.totalStormEvents).toBe(uploadReliability.totalStormEvents);
      expect(serverReliability.retryStormPct).toBe(uploadReliability.retryStormPct);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
