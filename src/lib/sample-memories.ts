// Sample agent memories for the public sample (issue #537).
//
// The Memories view (#458) reads `~/.claude/projects/<slug>/memory/*.md` via the
// `/api/memories` endpoint. Like Insights, that data CANNOT ride the upload zip
// (the bundled corpus keeps only `.jsonl`), and the sample stub returns `{ projects: [] }`,
// so in demo mode the view would render empty. This module ships a representative
// raw `MemoriesResponse` that App.tsx runs through the real `parseMemories` —
// exercising the same path the server build uses — when sample mode activates.
//
// It is lazy-imported (only when demo mode turns on), so it stays off the
// cold-load path and out of real uploads. Project slugs mirror the sample
// corpus (`scripts/sample-data/build-corpus.mjs`) so the demo's Memories join
// the same fake projects every other section shows. Content is entirely
// synthetic — no real paths, secrets, or `/api/` literals (sample-boundary clean).

import type { MemoriesResponse } from './parse-memories';

/**
 * Representative memories across the four sample projects. Shaped exactly like
 * the `/api/memories` payload, so `parseMemories(sampleMemories)` produces the
 * same `ProjectMemories[]` the server path would.
 */
export const sampleMemories: MemoriesResponse = {
  projects: [
    {
      slug: '-home-dev-acme-web',
      files: [
        {
          name: 'orders-pagination-cursor.md',
          content: `---
name: orders-pagination-cursor
description: Orders list paginates by opaque cursor, never offset — offset double-counts under concurrent writes
metadata:
  type: project
---

The orders list endpoint paginates with an opaque \`cursor\` (base64 of the last
row's \`created_at\` + \`id\`), NOT \`offset\`. Offset paging double-counted rows when
new orders landed mid-scroll. See [[checkout-rounding-per-line-item]] for the
related money-handling rule on the same service.`,
        },
        {
          name: 'auth-middleware-is-reusable.md',
          content: `---
name: auth-middleware-is-reusable
description: Token check lives in one withAuth() wrapper — never re-implement it per route
metadata:
  type: feedback
---

The token check is a single \`withAuth()\` wrapper applied at the router; routes
must not re-implement it inline.

**Why:** an earlier inline copy drifted and skipped the expiry check on one route.
**How to apply:** wrap new authed routes with \`withAuth()\` and add a test that a
missing/expired token returns 401.`,
        },
      ],
    },
    {
      slug: '-home-dev-payments-api',
      files: [
        {
          name: 'checkout-rounding-per-line-item.md',
          content: `---
name: checkout-rounding-per-line-item
description: Round each line item before summing — summing then rounding is off by a cent on multi-item carts
metadata:
  type: project
---

Checkout totals round **per line item** before summing. Summing raw floats then
rounding once produced an off-by-one-cent total on multi-item carts. The
regression test \`multi-item cart total\` locks this in.`,
        },
        {
          name: 'webhook-handler-is-idempotent.md',
          content: `---
name: webhook-handler-is-idempotent
description: Payment webhook dedupes on event id — providers retry, so handlers must be idempotent
metadata:
  type: reference
---

The payment webhook handler dedupes on the provider's \`event_id\` (unique index +
upsert). Providers retry delivery, so the handler must stay idempotent.`,
        },
      ],
    },
    {
      slug: '-home-dev-ml-pipeline',
      files: [
        {
          name: 'nightly-etl-uses-cursor.md',
          content: `---
name: nightly-etl-uses-cursor
description: Nightly ETL reads by indexed cursor, not full-table scan — the scan was the timeout
metadata:
  type: project
---

The nightly ETL job reads incrementally by an indexed \`updated_at\` cursor. The
original full-table re-scan each pass was the cause of the timeouts; an index +
cursor fixed it.`,
        },
      ],
    },
    {
      slug: '-home-dev-infra',
      files: [
        {
          name: 'ci-runs-lint-and-build.md',
          content: `---
name: ci-runs-lint-and-build
description: Every PR runs lint + build in CI before review — keep them green locally first
metadata:
  type: feedback
---

CI runs lint + build on every PR.

**Why:** red CI blocks review and wastes a round-trip.
**How to apply:** run lint and build locally and fix errors before pushing.`,
        },
      ],
    },
  ],
};
