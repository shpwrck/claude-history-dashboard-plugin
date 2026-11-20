import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { loadSampleBundle, readSampleArchive } from './sample-data';

// #3804: the public sample reads its bundled ZIP through the neutral archive
// reader, not the upload loader.
const sampleZip = zipSync({
  'history.jsonl': strToU8('{"display":"hi"}\n'),
  'projects/demo/s-1.jsonl': strToU8('{"type":"user"}\n'),
  'projects/other/s-2.jsonl': strToU8('{"type":"assistant"}\n'),
  'README.md': strToU8('not part of the sample corpus'),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSampleArchive', () => {
  it('reads .jsonl entries with their project slug and skips everything else', async () => {
    const files = await readSampleArchive(sampleZip);
    expect(files).toEqual([
      { name: 'history.jsonl', text: '{"display":"hi"}\n' },
      { name: 's-1.jsonl', text: '{"type":"user"}\n', project: 'demo' },
      { name: 's-2.jsonl', text: '{"type":"assistant"}\n', project: 'other' },
    ]);
  });
});

describe('loadSampleBundle', () => {
  it('splits the fetched archive into history and session channels', async () => {
    const fetchMock = vi.fn(async () => new Response(sampleZip));
    vi.stubGlobal('fetch', fetchMock);

    const bundle = await loadSampleBundle();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/sample-data\.zip$/));
    expect(bundle?.historyText).toBe('{"display":"hi"}\n');
    expect(bundle?.sessionFiles.map((f) => [f.name, f.project])).toEqual([
      ['s-1.jsonl', 'demo'],
      ['s-2.jsonl', 'other'],
    ]);
    expect(bundle?.sessionIds).toEqual(['s-1', 's-2']);
  });

  it('returns null when the asset is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect(await loadSampleBundle()).toBeNull();
  });

  it('returns null for an unreadable archive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(strToU8('not a zip'))));
    expect(await loadSampleBundle()).toBeNull();
  });
});
