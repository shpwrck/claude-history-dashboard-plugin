// Public-sample data loader (issue #526).
//
// The sample has no server, upload affordance, or ~/.claude mount. To demo the product we ship a
// build-generated `sample-data.zip` (emitted by the Vite plugin in
// vite.config.ts) as a static asset and load it through the neutral archive
// reader into the existing in-browser parse path (#3804). This module just fetches + inflates that asset;
// the parsing/state wiring lives in App.tsx.
//
// Boundary note: the only network call is a static `fetch` of the bundled zip
// (relative to import.meta.env.BASE_URL). It deliberately contains none of the
// server-touching strings the sample-boundary CI grep forbids (`/api/`,
// `EventSource`, `csrf-token`, `policy/write`).

import { readArchiveBytes, type ArchiveEntry, type ArchiveEntryInfo } from './archive-reader';

/** One transcript (or history) file from the sample archive. */
export interface SampleFile {
  name: string;
  text: string;
  /** Project slug recovered from `projects/<slug>/<sessionId>.jsonl`. */
  project?: string;
}

export interface SampleBundle {
  /** Contents of history.jsonl, or null if the zip had none. */
  historyText: string | null;
  /** Session transcript files, in the {name,text,project?} parse shape. */
  sessionFiles: SampleFile[];
  /** Session ids (filename minus .jsonl) — used to template sample insights. */
  sessionIds: string[];
}

/** Asset name the Vite sample plugin emits into the build output. */
const SAMPLE_ZIP = 'sample-data.zip';

// The sample corpus (scripts/sample-data/build-corpus.mjs corpusZipEntries) is
// only history.jsonl plus projects/<slug>/<sessionId>.jsonl transcripts, so the
// sample reads .jsonl entries and skips anything else before decompression.
function admitSampleEntry(entry: ArchiveEntryInfo): 'read' | 'skip' {
  return entry.name.endsWith('.jsonl') ? 'read' : 'skip';
}

function toSampleFile(entry: ArchiveEntry): SampleFile {
  const project = entry.path.match(/projects\/([^/]+)\//)?.[1];
  return project === undefined
    ? { name: entry.name, text: entry.text }
    : { name: entry.name, text: entry.text, project };
}

/** Inflate the sample archive bytes into its .jsonl files (exported for tests). */
export function readSampleArchive(bytes: Uint8Array): Promise<SampleFile[]> {
  return readArchiveBytes(bytes, { admit: admitSampleEntry, map: toSampleFile });
}

/**
 * Fetch and inflate the bundled sample zip, split into history and session
 * channels. Returns null when the asset is missing
 * or unreadable, so the caller can show an unavailable sample state.
 */
export async function loadSampleBundle(): Promise<SampleBundle | null> {
  try {
    const base = import.meta.env.BASE_URL || '/';
    const res = await fetch(`${base}${SAMPLE_ZIP}`);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const loaded = await readSampleArchive(bytes);
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
