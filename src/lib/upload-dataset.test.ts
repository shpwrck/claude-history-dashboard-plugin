import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  buildUploadDataset,
  type UploadInput,
  type UploadPipelineMessage,
} from './upload-dataset';

// A unique marker embedded in a secret file's body. If it ever appears in a
// posted *result* (anything other than a status line), the pipeline leaked
// decoded text it should have filtered — the exact thing #1069 guards against.
const SECRET_MARKER = 'TOPSECRET_DO_NOT_LEAK';

/** Run the build and capture every posted message. */
async function run(inputs: UploadInput[]) {
  const messages: UploadPipelineMessage[] = [];
  const summary = await buildUploadDataset(
    inputs,
    (msg) => messages.push(msg),
    { nowMs: 1_700_000_000_000 }
  );
  const results = messages.filter((m) => m.type !== 'status');
  return { messages, results, summary };
}

/** Loose (non-zip) input from in-memory text — mirrors a read File handle. */
function looseInput(name: string, relativePath: string, text: string): UploadInput {
  return {
    name,
    relativePath,
    blob: { text: async () => text } as unknown as Blob,
  };
}

/** A `.zip` input backed by bytes, forcing the arrayBuffer inflation path. */
function zipInput(name: string, files: Record<string, string>): UploadInput {
  const bytes = zipSync(
    Object.fromEntries(Object.entries(files).map(([p, t]) => [p, strToU8(t)]))
  );
  return {
    name,
    blob: {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(0),
    } as unknown as Blob,
  };
}

describe('buildUploadDataset (#1069)', () => {
  it('reports no usable files for an empty selection', async () => {
    const { summary, results } = await run([]);
    expect(summary.usableFiles).toBe(0);
    // Only the always-on artifacts result; no history/session/aux data.
    expect(results.every((m) => m.type === 'artifacts')).toBe(true);
  });

  it('parses loose history and session files, posting parsed results not text', async () => {
    const { results, summary } = await run([
      looseInput('history.jsonl', 'history.jsonl', '{"display":"hi","project":"/x"}\n'),
      looseInput('sess1.jsonl', 'projects/demo/sess1.jsonl', '{"type":"summary"}\n'),
    ]);

    const history = results.find((m) => m.type === 'history');
    expect(history).toBeTruthy();

    const index = results.find((m) => m.type === 'sessionIndex');
    expect(index && index.type === 'sessionIndex' && index.sessionIds).toEqual(['sess1']);

    // history + one session blob.
    expect(summary.usableFiles).toBe(2);
  });

  it('inflates a zip, filters sensitive files, and never leaks decoded text', async () => {
    const { results, summary, messages } = await run([
      zipInput('bundle.zip', {
        'projects/demo/sess1.jsonl': '{"type":"summary"}\n',
        'projects/demo/memory/note.md': '# note\nremember this',
        // Sensitive — must be dropped by the unzip filter, never decompressed.
        'credentials.json': `{"token":"${SECRET_MARKER}"}`,
      }),
    ]);

    // The user's own memory note rode through as a parsed result.
    const memories = results.find((m) => m.type === 'memories');
    expect(memories).toBeTruthy();

    // session blob + memory note are both usable.
    expect(summary.usableFiles).toBeGreaterThanOrEqual(2);

    // The secret never appears in ANY posted message — status or result.
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(SECRET_MARKER);
  });

  it('parseOnly mode emits only session passes, skipping history/transcript/aux', async () => {
    const { messages, results } = await (async () => {
      const msgs: UploadPipelineMessage[] = [];
      await buildUploadDataset(
        [
          looseInput('history.jsonl', 'history.jsonl', '{"display":"hi","project":"/x"}\n'),
          { name: 'sess1.jsonl', project: 'demo', blob: { text: async () => '{"type":"summary"}\n' } as unknown as Blob },
        ],
        (m) => msgs.push(m),
        { parseOnly: true, nowMs: 1 }
      );
      return { messages: msgs, results: msgs.filter((m) => m.type !== 'status') };
    })();

    const types = new Set(results.map((m) => m.type));
    // Parse passes + the session index, but NONE of history/transcript/aux.
    expect(types.has('sessionIndex')).toBe(true);
    expect(types.has('tokens')).toBe(true);
    expect(types.has('history')).toBe(false);
    expect(types.has('transcriptEntries')).toBe(false);
    expect(types.has('artifacts')).toBe(false);
    expect(types.has('memories')).toBe(false);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('uses an explicit project when no relativePath is present', async () => {
    const messages: UploadPipelineMessage[] = [];
    await buildUploadDataset(
      [{ name: 'sess1.jsonl', project: 'my-proj', blob: { text: async () => '{"type":"summary"}\n' } as unknown as Blob }],
      (m) => messages.push(m),
      { parseOnly: true, nowMs: 1 }
    );
    const index = messages.find((m) => m.type === 'sessionIndex');
    expect(index && index.type === 'sessionIndex' && index.sessionIds).toEqual(['sess1']);
  });

  it('keeps a file-history snapshot as metadata-only without reading its body', async () => {
    let read = false;
    const metadataInput: UploadInput = {
      name: 'foo.txt@v2',
      relativePath: 'file-history/sessX/foo.txt@v2',
      blob: {
        text: async () => {
          read = true;
          return SECRET_MARKER;
        },
      } as unknown as Blob,
    };
    const { summary, messages } = await run([metadataInput]);
    expect(read).toBe(false);
    expect(summary.usableFiles).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(messages)).not.toContain(SECRET_MARKER);
  });

  // #3177: the retained decoded text is bounded by an admitted-byte budget.
  describe('admitted decoded-byte budget (#3177)', () => {
    // A corpus of several session transcripts, each a chunky body.
    const bigBody = (marker: string) =>
      Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ type: 'summary', note: `${marker}-${i}-${'x'.repeat(200)}` })
      ).join('\n') + '\n';
    const corpus = (): UploadInput[] => [
      looseInput('history.jsonl', 'history.jsonl', '{"display":"hi","project":"/x"}\n'),
      looseInput('s1.jsonl', 'projects/demo/s1.jsonl', bigBody('s1')),
      looseInput('s2.jsonl', 'projects/demo/s2.jsonl', bigBody('s2')),
      looseInput('s3.jsonl', 'projects/demo/s3.jsonl', bigBody('s3')),
      looseInput('s4.jsonl', 'projects/demo/s4.jsonl', bigBody('s4')),
    ];

    async function runWith(inputs: UploadInput[], admittedByteBudget?: number) {
      const messages: UploadPipelineMessage[] = [];
      const summary = await buildUploadDataset(
        inputs,
        (m) => messages.push(m),
        { nowMs: 1_700_000_000_000, ...(admittedByteBudget != null ? { admittedByteBudget } : {}) }
      );
      return { messages, summary, results: messages.filter((m) => m.type !== 'status') };
    }

    it('retains no more decoded text than the budget and reports truncation', async () => {
      const budget = 1_500; // well below the ~4 x 4KB corpus
      const { summary, messages } = await runWith(corpus(), budget);
      expect(summary.truncated).toBe(true);
      expect(summary.droppedFiles).toBeGreaterThan(0);
      // The hard guarantee: retained decoded text never exceeded the budget.
      expect(summary.admittedTextLength).toBeLessThanOrEqual(budget);
      // The over-budget condition is surfaced, not silent.
      const statuses = messages
        .filter((m): m is { type: 'status'; message: string } => m.type === 'status')
        .map((m) => m.message);
      expect(statuses.some((s) => /budget/.test(s))).toBe(true);
    });

    it('is byte-identical to the un-budgeted run for an in-budget corpus', async () => {
      const baseline = await runWith(corpus()); // default (1 GiB) budget
      const generous = await runWith(corpus(), 10_000_000); // still in-budget
      expect(baseline.summary.truncated).toBe(false);
      expect(baseline.summary.droppedFiles).toBe(0);
      expect(generous.summary.truncated).toBe(false);
      // Same parsed results (compare non-status messages) and same usable count.
      expect(JSON.stringify(generous.results)).toEqual(JSON.stringify(baseline.results));
      expect(generous.summary.usableFiles).toBe(baseline.summary.usableFiles);
    });
  });
});
