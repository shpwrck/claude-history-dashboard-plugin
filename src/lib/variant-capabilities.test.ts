import { describe, expect, it } from 'vitest';
import {
  variantCapabilities,
  type VariantCapabilities,
} from './variant-capabilities';
import { isNavViewAvailable, SERVER_DATA_VIEWS, LIVE_SERVER_VIEWS } from './nav-prefs';
import type { View } from '../types';

// Caps that stand in for each delivery variant. (The live `sample` branch keys
// on `import.meta.env.MODE`, which is not 'sample' under vitest, so we exercise
// the predicate with explicit cap objects rather than stubbing the build mode.)
const SAMPLE: VariantCapabilities = { showUpload: false, hasServerData: true, hasLiveServer: false };
const UPLOAD: VariantCapabilities = { showUpload: true, hasServerData: false, hasLiveServer: false };
const SERVER: VariantCapabilities = { showUpload: true, hasServerData: true, hasLiveServer: true };

const aServerDataView = [...SERVER_DATA_VIEWS][0] as View;
const aLiveServerView = [...LIVE_SERVER_VIEWS][0] as View;

describe('variantCapabilities (build-derived)', () => {
  it('maps serverAvailable=true to the full server profile', () => {
    expect(variantCapabilities(true)).toEqual(SERVER);
  });
  it('maps serverAvailable=false to the upload profile', () => {
    expect(variantCapabilities(false)).toEqual(UPLOAD);
  });
});

describe('isNavViewAvailable', () => {
  it('always shows ungated (none) views', () => {
    expect(isNavViewAvailable('home', SAMPLE)).toBe(true);
    expect(isNavViewAvailable('home', UPLOAD)).toBe(true);
    expect(isNavViewAvailable('home', SERVER)).toBe(true);
  });

  it('shows serverData views on sample (full corpus) and server, not bare upload', () => {
    expect(isNavViewAvailable(aServerDataView, SAMPLE)).toBe(true);
    expect(isNavViewAvailable(aServerDataView, SERVER)).toBe(true);
    expect(isNavViewAvailable(aServerDataView, UPLOAD)).toBe(false);
  });

  it('shows a serverData view on upload only when the upload covers it', () => {
    const covered = new Set<View>([aServerDataView]);
    expect(isNavViewAvailable(aServerDataView, UPLOAD, covered)).toBe(true);
  });

  it('shows liveServer views only on the server tier', () => {
    expect(isNavViewAvailable(aLiveServerView, SERVER)).toBe(true);
    expect(isNavViewAvailable(aLiveServerView, SAMPLE)).toBe(false);
    expect(isNavViewAvailable(aLiveServerView, UPLOAD)).toBe(false);
    // an upload-covered set never promotes a liveServer view
    expect(isNavViewAvailable(aLiveServerView, UPLOAD, new Set([aLiveServerView]))).toBe(false);
  });
});
