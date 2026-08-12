/**
 * Delivery-variant capability matrix (epic #1852, ADR 0014 tiered delivery).
 *
 * One declarative source of truth for "what is available in this build/tier",
 * replacing the scattered `SAMPLE_MODE` / `SERVER_AVAILABLE` / `serverOnly`
 * checks. Each public delivery surface is a `DeliveryVariant`; each variant
 * advertises a capability profile. Views declare a `ViewRequirement`
 * (see `NavItem.requires`) and are shown when the variant's profile meets it.
 *
 * The split that makes the matrix work (see ADR 0014):
 *  - `serverData` — the view only needs a rich dataset to render. The **sample**
 *    showcase has the full sample corpus, so it shows these (full-app demo); a
 *    user **upload** shows the ones its own data covers; a **server** has them all.
 *  - `liveServer` — the view needs the live backend control plane (e.g. Enterprise
 *    admin roster, remote-session provisioning). Only the **server** tier has it,
 *    and these stay excluded from the public sample builds — both because they cannot
 *    function and because their server-touching code would trip the `sample-boundary`
 *    publish gate.
 */
import { SERVER_AVAILABLE } from '@api-client';
import { SAMPLE_MODE } from './build-mode';
import type { View } from '../types';

export type DeliveryVariant = 'sample' | 'upload' | 'server';

/** What a view needs in order to render. Absent = available everywhere. */
export type ViewRequirement = 'serverData' | 'liveServer';

export interface VariantCapabilities {
  /** Show the masthead Upload affordance (analyse your own `~/.claude`). */
  showUpload: boolean;
  /** The dataset is rich enough to render `serverData` views. */
  hasServerData: boolean;
  /** The live backend control plane is present (gates `liveServer` views). */
  hasLiveServer: boolean;
}

/**
 * The variant this bundle is running as. `serverAvailable` defaults to the
 * build-time `SERVER_AVAILABLE`, but callers that hold a more precise runtime
 * value (e.g. one folding in the enterprise session, like the PFLayout
 * `serverAvailable` prop) pass it explicitly so the caps track that value —
 * which also keeps the matrix unit-testable without stubbing the module.
 */
export function deliveryVariant(
  serverAvailable: boolean = SERVER_AVAILABLE
): DeliveryVariant {
  if (SAMPLE_MODE) return 'sample';
  return serverAvailable ? 'server' : 'upload';
}

const CAPABILITIES: Record<DeliveryVariant, VariantCapabilities> = {
  // coach.skrzypek.dev — static showcase: full app on the sample corpus, no upload.
  sample: { showUpload: false, hasServerData: true, hasLiveServer: false },
  // Public browser-only variants have no live backend.
  upload: { showUpload: true, hasServerData: false, hasLiveServer: false },
  // self-hosted / live server — everything (further narrowed by enterprise session caps).
  server: { showUpload: true, hasServerData: true, hasLiveServer: true },
};

export function variantCapabilities(
  serverAvailable: boolean = SERVER_AVAILABLE
): VariantCapabilities {
  return CAPABILITIES[deliveryVariant(serverAvailable)];
}

/**
 * Whether a view with `requirement` is available under `caps`. The upload tier
 * has no blanket server data, but specific `serverData` views whose data the
 * user's upload happens to cover are passed via `uploadCoveredViews`.
 */
export function isViewAvailable(
  view: View,
  requirement: ViewRequirement | undefined,
  caps: VariantCapabilities,
  uploadCoveredViews: ReadonlySet<View> = new Set()
): boolean {
  if (!requirement) return true;
  if (requirement === 'liveServer') return caps.hasLiveServer;
  // serverData
  return caps.hasServerData || uploadCoveredViews.has(view);
}
