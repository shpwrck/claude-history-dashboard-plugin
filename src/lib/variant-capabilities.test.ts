import { describe, expect, it } from 'vitest';
import {
  deliveryVariant,
  variantCapabilities,
  type VariantCapabilities,
} from './variant-capabilities';
import { isNavViewAvailable, SERVER_DATA_VIEWS, LIVE_SERVER_VIEWS } from './nav-prefs';
import type { View } from '../types';

// Caps that stand in for each delivery variant. (The live `sample` branch keys
// on `import.meta.env.MODE`, which is not 'sample' under vitest, so we exercise
// the predicate with explicit cap objects rather than stubbing the build mode.)
const SAMPLE: VariantCapabilities = { hasServerData: true, hasLiveServer: false };
const SERVER: VariantCapabilities = { hasServerData: true, hasLiveServer: true };
// Not a delivery variant (the browser-only upload tier was retired in #3807).
// Kept only to exercise isViewAvailable's covered-views override until #3814
// removes it.
const NO_SERVER_DATA: VariantCapabilities = { hasServerData: false, hasLiveServer: false };

const aServerDataView = [...SERVER_DATA_VIEWS][0] as View;
const aLiveServerView = [...LIVE_SERVER_VIEWS][0] as View;

describe('variantCapabilities (build-derived)', () => {
  it('maps serverAvailable=true to the full server profile', () => {
    expect(deliveryVariant(true)).toBe('server');
    expect(variantCapabilities(true)).toEqual(SERVER);
  });

  it('maps serverAvailable=false to the sample profile (no upload variant, #3807)', () => {
    expect(deliveryVariant(false)).toBe('sample');
    expect(variantCapabilities(false)).toEqual(SAMPLE);
  });
});

describe('isNavViewAvailable', () => {
  it('always shows ungated (none) views', () => {
    expect(isNavViewAvailable('home', SAMPLE)).toBe(true);
    expect(isNavViewAvailable('home', SERVER)).toBe(true);
  });

  it('shows serverData views on sample (full corpus) and server', () => {
    expect(isNavViewAvailable(aServerDataView, SAMPLE)).toBe(true);
    expect(isNavViewAvailable(aServerDataView, SERVER)).toBe(true);
  });

  it('shows liveServer views only on the server tier', () => {
    expect(isNavViewAvailable(aLiveServerView, SERVER)).toBe(true);
    expect(isNavViewAvailable(aLiveServerView, SAMPLE)).toBe(false);
  });

  it('honours the covered-views override without promoting liveServer views', () => {
    expect(isNavViewAvailable(aServerDataView, NO_SERVER_DATA)).toBe(false);
    expect(isNavViewAvailable(aServerDataView, NO_SERVER_DATA, new Set([aServerDataView]))).toBe(true);
    expect(isNavViewAvailable(aLiveServerView, NO_SERVER_DATA, new Set([aLiveServerView]))).toBe(false);
  });
});
