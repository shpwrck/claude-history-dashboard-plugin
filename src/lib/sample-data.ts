// Marketing-SPA sample-data loader (issue #526).
//
// In SPA mode the dashboard has no server and no ~/.claude mount — a first-time
// visitor would see an empty upload modal. To demo the product we ship a
// build-generated `sample-data.zip` (emitted by the Vite plugin in
// vite.config.ts) as a static asset and load it through the SAME unzip -> parse
// path as a real upload. This module just fetches + inflates that asset; the
// parsing/state wiring lives in App.tsx exactly like the upload flow.
//
// Boundary note: the only network call is a static `fetch` of the bundled zip
// (relative to import.meta.env.BASE_URL). It deliberately contains none of the
// server-touching strings the spa-boundary CI grep forbids (`/api/`,
// `EventSource`, `csrf-token`, `policy/write`).

import { unzipBundle, type LoadedFile } from './unzip-upload';

export interface SampleBundle {
  /** Contents of history.jsonl, or null if the zip had none. */
  historyText: string | null;
  /** Session transcript files, in the {name,text,project?} upload shape. */
  sessionFiles: LoadedFile[];
  /** Session ids (filename minus .jsonl) — used to template sample insights. */
  sessionIds: string[];
}

/** Asset name the Vite SPA plugin emits into the build output. */
const SAMPLE_ZIP = 'sample-data.zip';

/**
 * Fetch and inflate the bundled sample zip, split into the same history vs
 * session channels FileUpload produces. Returns null when the asset is missing
 * or unreadable, so the caller can fall back to the upload modal.
 */
export async function loadSampleBundle(): Promise<SampleBundle | null> {
  try {
    const base = import.meta.env.BASE_URL || '/';
    const res = await fetch(`${base}${SAMPLE_ZIP}`);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const loaded = await unzipBundle(bytes);
    if (loaded.length === 0) return null;

    const historyFile = loaded.find((f) => f.name === 'history.jsonl');
    const sessionFiles = loaded.filter(
      (f) => f.name.endsWith('.jsonl') && f.name !== 'history.jsonl'
    );
    return {
      historyText: historyFile ? historyFile.text : null,
      sessionFiles,
      sessionIds: sessionFiles.map((f) => f.name.replace(/\.jsonl$/, '')),
    };
  } catch {
    return null;
  }
}
