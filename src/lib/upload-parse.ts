// Shared upload-parse pipeline (#1015, relates #855/#868; #1069).
//
// The 11 parse passes a user upload runs (sessions, tools, tool inventory,
// timeline, api errors, permissions, agent settings, attribution, runtime,
// churn geometry, value flow) used
// to live inline in App.tsx's handleSessionFiles, on the main thread. This
// module is the single source of truth for that pipeline so it runs identically
// wherever it is driven:
//
//   - inside the upload pipeline worker (upload-pipeline-worker.ts via
//     upload-dataset.ts) — the default for a user upload, where inflation and
//     the CPU-heavy parse run entirely off the UI thread (#1069), and
//   - on the main thread with `yielding` — the pipeline's no-Worker fallback,
//     and the SPA sample-data path (a small curated corpus) — where it stays
//     responsive via mapChunked's between-chunk yields.
//
// Each pass `emit`s its parsed result as soon as it finishes, preserving the
// progressive-render UX (sections populate one pass at a time). The caller owns
// dedup/merge into React state; this module is pure parse + emit.

import { mapChunked } from './chunked';
import type { SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { ToolInventory } from './parse-tool-inventory';
import type { SessionTimeline as SessionTimelineData } from './parse-timeline';
import type { ApiErrorEvent } from './parse-errors';
import type { PermissionChange } from './parse-permissions';
import type { AgentSettingEvent, SessionAttribution } from './parse-agents';
import type { RuntimeEvents } from './parse-runtime-events';
import type { ChurnGeometrySession } from './parse-churn-geometry';
import type { ValueFlowSession } from './parse-value-flow';

export interface UploadFile {
  name: string;
  text: string;
  project?: string;
}

/** Raw parsed permission shape (one entry per session file). */
export interface PermissionParse {
  perModeEntries: { mode: string; sessionId: string }[];
  changes: PermissionChange[];
}

/** One progressive pass result, posted as soon as that parse finishes. */
export type UploadParseEmit =
  | { type: 'tokens'; data: SessionTokenData[] }
  | { type: 'tools'; data: ToolUsageData[] }
  | { type: 'inventories'; data: ToolInventory[] }
  | { type: 'timelines'; data: SessionTimelineData[] }
  | { type: 'apiErrors'; data: ApiErrorEvent[] }
  | { type: 'permissions'; data: PermissionParse[] }
  | { type: 'agentSettings'; data: AgentSettingEvent[] }
  | { type: 'attribution'; data: SessionAttribution[] }
  | { type: 'runtime'; data: RuntimeEvents[] }
  | { type: 'churnGeometry'; data: ChurnGeometrySession[] }
  | { type: 'valueFlow'; data: ValueFlowSession[] };

export interface RunUploadParseOptions {
  /**
   * Yield the event loop between file chunks (via mapChunked). Use on the main
   * thread so the UI stays responsive; leave off in a worker, where there is no
   * UI to keep alive and a tight map is fastest.
   */
  yielding?: boolean;
}

/**
 * Run all upload parse passes over `files`, calling `emit` once per pass with
 * that pass's parsed result. Identical output regardless of `yielding`.
 */
export async function runUploadParse(
  files: UploadFile[],
  emit: (msg: UploadParseEmit) => void,
  opts: RunUploadParseOptions = {}
): Promise<void> {
  const [
    { parseSessionJsonl },
    { parseToolUsage },
    { parseToolInventory },
    { parseSessionTimeline },
    { parseApiErrors },
    { parsePermissionData },
    { parseAgentSettings, parseAttribution },
    { parseRuntimeEvents },
    { parseChurnGeometry },
    { parseValueFlow },
  ] = await Promise.all([
    import('./parse-sessions'),
    import('./parse-tools'),
    import('./parse-tool-inventory'),
    import('./parse-timeline'),
    import('./parse-errors'),
    import('./parse-permissions'),
    import('./parse-agents'),
    import('./parse-runtime-events'),
    import('./parse-churn-geometry'),
    import('./parse-value-flow'),
  ]);

  const runMap = async <R>(fn: (f: UploadFile) => R): Promise<R[]> =>
    opts.yielding ? mapChunked(files, fn) : files.map(fn);

  const tokens = (
    await runMap((f) => parseSessionJsonl(f.text, f.name, f.project))
  ).filter((d): d is SessionTokenData => d !== null);
  emit({ type: 'tokens', data: tokens });

  const tools = (await runMap((f) => parseToolUsage(f.text, f.name))).filter(
    (d): d is ToolUsageData => d !== null
  );
  emit({ type: 'tools', data: tools });

  const inventories = (
    await runMap((f) => parseToolInventory(f.text, f.name))
  ).filter((d): d is ToolInventory => d !== null);
  emit({ type: 'inventories', data: inventories });

  const timelines = (
    await runMap((f) => parseSessionTimeline(f.text, f.name))
  ).filter((d): d is SessionTimelineData => d !== null);
  emit({ type: 'timelines', data: timelines });

  const apiErrors = (await runMap((f) => parseApiErrors(f.text, f.name))).flat();
  emit({ type: 'apiErrors', data: apiErrors });

  const permissions = (
    await runMap((f) => parsePermissionData(f.text, f.name))
  ).filter((d): d is PermissionParse => d !== null);
  emit({ type: 'permissions', data: permissions });

  const agentSettings = (
    await runMap((f) => parseAgentSettings(f.text, f.name))
  ).flat();
  emit({ type: 'agentSettings', data: agentSettings });

  const attribution = (
    await runMap((f) => parseAttribution(f.text, f.name))
  ).filter((d): d is SessionAttribution => d !== null);
  emit({ type: 'attribution', data: attribution });

  const runtime = (
    await runMap((f) => parseRuntimeEvents(f.text, f.name))
  ).filter((d): d is RuntimeEvents => d !== null);
  emit({ type: 'runtime', data: runtime });

  const churnGeometry = (
    await runMap((f) => parseChurnGeometry(f.text, f.name))
  ).filter((d): d is ChurnGeometrySession => d !== null);
  emit({ type: 'churnGeometry', data: churnGeometry });

  const valueFlow = (
    await runMap((f) =>
      parseValueFlow(f.text, f.name, { includeHypotheses: false })
    )
  ).filter((d): d is ValueFlowSession => d !== null);
  emit({ type: 'valueFlow', data: valueFlow });
}
