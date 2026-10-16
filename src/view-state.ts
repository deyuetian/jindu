const storageKey = 'jindu:page-selections:v1';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function compatible(value: unknown, fallback: unknown): boolean {
  if (typeof fallback === 'string') return typeof value === 'string' && value.length <= 1000;
  if (typeof fallback === 'number') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100000;
  if (typeof fallback === 'boolean') return typeof value === 'boolean';
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(fallback).every(([k, v]) => Object.hasOwn(value, k) && compatible((value as Record<string, unknown>)[k], v));
  }
  return false;
}

/** Only UI selections belong here. Business responses, drafts and credentials
 * stay out of browser storage. Sign-out and expired authentication clear it. */
export function createViewState(storage?: StoragePort) {
  let saved: Record<string, unknown> = {};
  try {
    const raw = storage?.getItem(storageKey);
    const value: unknown = raw && raw.length < 50000 ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value as Record<string, unknown>;
  } catch { /* Private-mode storage may be unavailable; memory still works. */ }
  const values = new Map<string, unknown>(), listeners = new Set<() => void>();
  return {
    get<T>(key: string, fallback: T): T {
      if (!values.has(key)) values.set(key, Object.hasOwn(saved, key) && compatible(saved[key], fallback) ? saved[key] : fallback);
      return values.get(key) as T;
    },
    set<T>(key: string, value: T) {
      values.set(key, value);
      try { storage?.setItem(storageKey, JSON.stringify({...saved, ...Object.fromEntries(values)})); } catch { /* Keep the in-memory selection. */ }
      for (const notify of listeners) notify();
    },
    clear() {
      values.clear(); saved = {};
      try { storage?.removeItem(storageKey); } catch { /* Do not block sign-out. */ }
      for (const notify of listeners) notify();
    },
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
  };
}
export type ViewState = ReturnType<typeof createViewState>;
export function browserSelectionStorage() { try { return window.sessionStorage; } catch { return undefined; } }
