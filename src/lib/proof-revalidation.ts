/**
 * Browser-safe proof-freshness contract shared by adoption PROOF receipts and
 * shadow experiment readers. Keeping this pure prevents the browser-bundled
 * shadow parser from importing the Node-backed adoption receipt store.
 */
export const PROOF_REVALIDATION_STATUSES = ['current', 'stale', 'revoked'] as const;

export type ProofRevalidationStatus = (typeof PROOF_REVALIDATION_STATUSES)[number];

export function normalizeProofRevalidationStatus(
  value: unknown
): ProofRevalidationStatus | null {
  return typeof value === 'string' &&
    (PROOF_REVALIDATION_STATUSES as readonly string[]).includes(value)
    ? (value as ProofRevalidationStatus)
    : null;
}
