import { usePersistedState } from "./usePersistedState";

/**
 * useState backed by localStorage.
 * Thin wrapper around usePersistedState for backwards compatibility.
 */
export function useLocalStorage<T>(key: string, defaultValue: T) {
  return usePersistedState(key, defaultValue, localStorage);
}
