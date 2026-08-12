type StorageRemover = Pick<Storage, 'removeItem'>;

interface BrowserModelStorage {
  durable?: StorageRemover | null;
  session?: StorageRemover | null;
}

const RETIRED_DURABLE_KEYS = [
  'claude-history-dashboard:anthropic-api-key',
  'claude-history-dashboard:anthropic-default-model',
  'claude-history-dashboard:ask-fab-hidden',
] as const;

const RETIRED_SESSION_KEYS = [
  'claude-history-dashboard:anthropic-api-key',
] as const;

function browserStorage(name: 'localStorage' | 'sessionStorage') {
  try {
    return window[name];
  } catch {
    return null;
  }
}

function removeKeys(storage: StorageRemover | null, keys: readonly string[]) {
  for (const key of keys) {
    try {
      storage?.removeItem(key);
    } catch {
      // A blocked storage backend must not prevent cleanup of the other one.
    }
  }
}

/** Remove browser credentials and preferences left by the retired LLM surface. */
export function purgeRetiredBrowserModelState(
  storage: BrowserModelStorage = {}
): void {
  removeKeys(
    storage.durable === undefined
      ? browserStorage('localStorage')
      : storage.durable,
    RETIRED_DURABLE_KEYS
  );
  removeKeys(
    storage.session === undefined
      ? browserStorage('sessionStorage')
      : storage.session,
    RETIRED_SESSION_KEYS
  );
}
