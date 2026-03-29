const STORAGE_KEY = "grove-pane-sizes";

export interface PaneSizes {
  sidebar: number;
  chat: number;
}

export const DEFAULT_SIZES: PaneSizes = {
  sidebar: 240,
  chat: 320,
};

export function loadPaneSizes(): PaneSizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SIZES };
    const parsed = JSON.parse(raw);
    return {
      sidebar: typeof parsed.sidebar === "number" ? parsed.sidebar : DEFAULT_SIZES.sidebar,
      chat: typeof parsed.chat === "number" ? parsed.chat : DEFAULT_SIZES.chat,
    };
  } catch {
    return { ...DEFAULT_SIZES };
  }
}

export function savePaneSizes(sizes: PaneSizes): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
}

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
