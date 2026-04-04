import { useState, useCallback } from "react";

/**
 * useState backed by a Web Storage API (localStorage or sessionStorage).
 * Reads the stored value on first render; writes on every state change.
 * Falls back to `defaultValue` when the key is missing or the stored JSON
 * is unparseable.
 *
 * When `key` is undefined, the hook behaves as a plain useState — no
 * storage reads or writes occur. This avoids collisions on an empty key
 * when multiple keyless instances coexist.
 */
export function usePersistedState<T>(
  key: string | undefined,
  defaultValue: T,
  storage: Storage = localStorage,
) {
  const [value, setValue] = useState<T>(() => {
    if (!key) return defaultValue;
    try {
      const stored = storage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        if (key) {
          try {
            storage.setItem(key, JSON.stringify(resolved));
          } catch {
            // Storage full or unavailable — state still updates in memory
          }
        }
        return resolved;
      });
    },
    [key, storage],
  );

  return [value, set] as const;
}
