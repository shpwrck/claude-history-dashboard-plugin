// Shared ZIP fixtures for the archive-reader and unzip-upload suites (#3806).
// The byte offsets in `forgeDeclaredSize` are the load-bearing part of the
// #3176 forged-size proof, so they live in exactly one place.

import { strToU8, zipSync } from 'fflate';

export const MIB = 1024 * 1024;

/** Zip a path -> content map; string content is UTF-8 encoded. */
export function buildZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(tree);
}

/**
 * Overwrite the DECLARED uncompressed size in every local-file and
 * central-directory header. The compressed stream is untouched, so the entry
 * still inflates fully — DEFLATE is self-terminating and does not stop at the
 * declared length. This is what a hand-crafted malicious archive looks like:
 * the metadata says "tiny", the stream emits anything it likes (#3176).
 */
export function forgeDeclaredSize(zip: Uint8Array, declared: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i + 4 <= out.length; i += 1) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, declared, true);
    else if (sig === 0x02014b50) dv.setUint32(i + 24, declared, true);
  }
  return out;
}

/** Deterministic, incompressible bytes so a fixture stays large after DEFLATE. */
export function noise(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let state = 0x9e3779b9;
  for (let i = 0; i < bytes; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** Wrap a chunk so every `subarray` slice handed to fflate is recorded in `sizes`. */
export function observeSubarrays(chunk: Uint8Array, sizes: number[]): Uint8Array {
  return new Proxy(chunk, {
    get(target, property) {
      if (property === 'subarray') {
        return (start?: number, end?: number) => {
          const slice = target.subarray(start, end);
          sizes.push(slice.byteLength);
          return slice;
        };
      }
      return Reflect.get(target, property, target);
    },
  });
}
