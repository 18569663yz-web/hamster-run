// Safe storage wrapper (robustness fix, first shipped in the Cloudflare
// package and shared with the Muse-hosted build): every localStorage
// access in the client goes through here. Desktop browsers with storage
// blocked (private mode, site-data denial, some Chrome profiles) throw
// on ANY localStorage touch — including a bare `localStorage.getItem`
// in a useState initializer, which used to crash the app on frame one.
// These helpers never throw: reads fall back to null, writes/removes
// fail silently, and callers keep working with in-memory state.

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the value simply does not persist
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable — nothing to remove
  }
}
