import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilesystemArtifactSource,
  filesystemArtifactSource,
} from './artifact-source';
import type { DataSource } from './sources';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifact-source-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('artifact-source interface (ADR 0009 §1)', () => {
  it('resolves a root-relative path to join(rootDir, relPath)', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    expect(src.resolve('history.jsonl')).toBe(join(root, 'history.jsonl'));
    expect(src.resolve('telemetry')).toBe(join(root, 'telemetry'));
    // The empty relPath resolves to the root itself (the `~/.claude` dir).
    expect(src.resolve('')).toBe(root);
  });

  it('reads a file as text with a stat signature, and the signature tracks changes', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    writeFileSync(join(root, 'history.jsonl'), 'one\n');
    const first = src.read('history.jsonl');
    expect(first.text).toBe('one\n');
    expect(first.signature).toMatch(/^\d+(\.\d+)?:\d+$/);
    // Signature is content-sensitive (mtime + size): rewriting changes it.
    writeFileSync(join(root, 'history.jsonl'), 'one\ntwo\n');
    expect(src.read('history.jsonl').signature).not.toBe(first.signature);
  });

  it('caps reads at maxBytes', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    writeFileSync(join(root, 'big.jsonl'), 'x'.repeat(1024));
    expect(() => src.read('big.jsonl', { maxBytes: 16 })).toThrow(
      /exceeds 16 byte limit/
    );
  });

  it('lists immediate children as refs carrying source provenance + signature', () => {
    const src = new FilesystemArtifactSource({
      id: 'pod-7',
      harness: 'claude-code',
      rootDir: root,
    });
    const histD = join(root, 'history.d');
    mkdirSync(histD, { recursive: true });
    writeFileSync(join(histD, 'b.jsonl'), 'b\n');
    writeFileSync(join(histD, 'a.jsonl'), 'a\n');
    writeFileSync(join(histD, 'skip.txt'), 'nope\n');

    const refs = src
      .list('history.d', (e) => e.isFile && e.name.endsWith('.jsonl'))
      .sort((x, y) => (x.relPath < y.relPath ? -1 : 1));
    expect(refs.map((r) => r.relPath)).toEqual([
      join('history.d', 'a.jsonl'),
      join('history.d', 'b.jsonl'),
    ]);
    for (const ref of refs) {
      expect(ref.sourceId).toBe('pod-7');
      expect(ref.harness).toBe('claude-code');
      expect(ref.absPath).toBe(join(root, ref.relPath));
      expect(ref.signature).toMatch(/^\d+(\.\d+)?:\d+$/);
    }
  });

  it('list returns [] for a missing directory (never throws)', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    expect(src.list('does-not-exist')).toEqual([]);
  });

  it('exists reflects presence on disk', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    expect(src.exists('history.jsonl')).toBe(false);
    writeFileSync(join(root, 'history.jsonl'), 'x\n');
    expect(src.exists('history.jsonl')).toBe(true);
  });

  it('signature for a missing path is the stable absent sentinel 0:0', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    expect(src.signature('gone.json')).toBe('0:0');
  });

  it('filesystemArtifactSource roots a DataSource at dirname(historyDir)', () => {
    const source: DataSource = {
      id: 'claude-code',
      harness: 'claude-code',
      historyDir: join(root, '.claude', 'projects'),
    };
    const src = filesystemArtifactSource(source);
    expect(src.id).toBe('claude-code');
    expect(src.harness).toBe('claude-code');
    // The `~/.claude` root is the parent of `projects` — so `sessions`,
    // `history.jsonl`, etc. resolve exactly where the legacy join placed them.
    expect(src.resolve('sessions')).toBe(join(root, '.claude', 'sessions'));
    expect(src.resolve('history.jsonl')).toBe(
      join(root, '.claude', 'history.jsonl')
    );
  });

  it('a fixed mtime yields a deterministic signature', () => {
    const src = new FilesystemArtifactSource({
      id: 'local',
      harness: 'claude-code',
      rootDir: root,
    });
    writeFileSync(join(root, 'f.jsonl'), 'abcd');
    const when = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(join(root, 'f.jsonl'), when, when);
    expect(src.read('f.jsonl').signature).toBe(src.signature('f.jsonl'));
  });
});
