#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyProofReceiptAgainstEvidence,
} from '../src/lib/proof-evidence.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function usage() {
  console.error(
    'Usage: npm run proof:verify -- <finalized-receipt.json-or-jsonl>'
  );
}

function readReceipt(path) {
  const text = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed?.kind === 'PROOF') return parsed;
  } catch {
    // An append-only receipt log is JSONL, not one JSON document.
  }
  const proofReceipts = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed?.kind === 'PROOF' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  const receipt = proofReceipts.at(-1);
  if (!receipt) throw new Error('No PROOF receipt found');
  return receipt;
}

const receiptPath = process.argv[2];
if (!receiptPath || process.argv.length > 3) {
  usage();
  process.exit(2);
}

try {
  const receipt = readReceipt(receiptPath);
  if (typeof receipt.evidenceRef !== 'string' || !receipt.evidenceRef.trim()) {
    throw new Error('Receipt has no evidenceRef');
  }
  const evidencePath = isAbsolute(receipt.evidenceRef)
    ? receipt.evidenceRef
    : resolve(REPO_ROOT, receipt.evidenceRef);
  const artifact = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const verification = verifyProofReceiptAgainstEvidence(receipt, artifact);
  if (!verification.ok) throw new Error(verification.error);
  console.log(
    JSON.stringify(
      {
        ok: true,
        evidenceRef: receipt.evidenceRef,
        evidenceDigest: receipt.evidenceDigest,
        analysis: verification.analysis,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(`proof evidence verification failed: ${error.message}`);
  process.exit(1);
}
