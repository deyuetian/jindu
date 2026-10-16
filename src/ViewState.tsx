import {createContext, useCallback, useContext, useMemo, useSyncExternalStore, type SetStateAction} from 'react';
import {createViewState, type ViewState} from './view-state';

export const ViewStateContext = createContext<ViewState | null>(null);
export function useViewState<T>(key: string, initial: T, explicit?: ViewState): [T, (value: SetStateAction<T>) => void] {
  const context = useContext(ViewStateContext);
  const isolated = useMemo(() => createViewState(), []);
  const memory = explicit || context || isolated;
  // Defaults are fixed for a key, even when callers use an inline object.
  const fallback = useMemo(() => initial, [key]);
  const snapshot = useCallback(() => memory.get(key, fallback), [key, fallback, memory]);
  const value = useSyncExternalStore(memory.subscribe, snapshot, snapshot);
  const setValue = useCallback((next: SetStateAction<T>) => {
    memory.set(key, typeof next === 'function' ? (next as (old: T) => T)(snapshot()) : next);
  }, [key, memory, snapshot]);
  return [value, setValue];
}
