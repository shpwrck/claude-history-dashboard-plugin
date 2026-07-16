# [backlog] Ingest "Applying Brevity and Language Efficiency to Prompt Engineering" and mine it for recommendations

**Labels:** `backlog` · **Issue:** [#1589](https://github.com/shpwrck/claude-history-dashboard/issues/1589)

Source: https://prahladyeri.github.io/guides/applying-brevity-and-language-efficiency-to-prompt-engineering.html

> In-repo tracking copy of issue #1589.

## Why

A third-party guide on prompt brevity / language efficiency is a good candidate
to feed our recommendation engine — it maps directly onto the verbosity /
token-efficiency advice we already surface. Registering it in the
external-guidance pipeline gets it snapshotted, drift-tracked, and available as
"Learn More" backing for the relevant recommendations.

## Scope

Two parts: (1) ingest the document into the existing guidance pipeline,
(2) mine its concrete advice into recommendation facts/attachments.

### 1. Ingest

- **New source** in `SOURCE_REGISTRY` (`src/lib/external-guidance.ts`). This
  host is **not** `support.claude.com`, so it needs its own entry with
  `allowedUrlPrefixes: ['https://prahladyeri.github.io/guides/']`.
- **Trust-tier wrinkle:** the only tier today is `'first-party'` (Anthropic
  Support). This is a personal blog, so it needs a non-first-party tier
  (e.g. `'community'` / `'third-party'`). Decide the tier vocabulary and make
  sure downstream rendering/citation treats lower-trust guidance appropriately.
  **This is the main design decision to settle before coding.**
- **New article** in `GUIDANCE_ARTICLES`
  (`src/lib/external-guidance-registry.ts`): `id` (= snapshot filename stem),
  `source`, `url`, `target`, `suggestion`, and an `extractFacts` extractor.
- Generate the committed snapshot via `npm run ingest:guidance` (do not
  hand-edit `data/external-guidance/*.json` — the coverage/drift-guard tests and
  the next ingest run will revert it).

### 2. Mine for recommendations

- Read the article and extract its load-bearing, actionable claims (brevity
  tactics, redundant-phrasing removal, token-efficiency heuristics) into a
  per-article `extractFacts(text)` extractor — pure regex over snapshot text,
  with inline-fixture unit tests (pattern: `extractUsageLimitFacts` in
  `external-guidance-registry.test.ts`).
- Pick the attach `target` (`detectorId` or `category`) — the prompt-verbosity /
  token-efficiency recommendation is the natural home. If no suitable detector
  exists yet, note whether this warrants a **new detector** vs. attaching to an
  existing category, and split that into a follow-up (see
  `docs/adding-a-recommendation.md`).

## Acceptance / gate

- New source + article registered; snapshot committed under
  `data/external-guidance/`.
- `extractFacts` has inline-fixture unit tests; the registry↔snapshot coverage
  test and the drift-guard test pass.
- Guidance surfaces as a "Learn More" link on the targeted recommendation
  (never as a standalone rec), with trust tier reflected.
- `npm run lint && npx vite build && npx vitest run` green.

## Notes / risks

- Per-page provenance (`contentHash`) is enforced by tests — snapshot only via
  the ingest script.
- The weekly `.github/workflows/ingest-guidance.yml` will pick this up
  automatically once registered; expect drift PRs since a personal blog is less
  stable than Anthropic's docs.
- Confirm the blog's terms permit snapshotting; the politeness headers in the
  ingest script already apply.
