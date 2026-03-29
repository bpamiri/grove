import { useState, useCallback } from "react";

/**
 * useState backed by localStorage. Reads the stored value on first render;
 * writes on every state change. Falls back to `defaultValue` when the key
 * is missing or the stored JSON is unparseable.
 */
export function useLocalStorage<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Storage full or unavailable — state still updates in memory
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
