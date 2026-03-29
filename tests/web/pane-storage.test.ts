import { describe, test, expect, beforeEach } from "bun:test";
import { loadPaneSizes, savePaneSizes, DEFAULT_SIZES, clampWidth } from "../../web/src/lib/pane-storage";

// Mock localStorage
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};

// Inject mock before each test
beforeEach(() => {
  mockLocalStorage.clear();
  (globalThis as any).localStorage = mockLocalStorage;
});

describe("pane-storage", () => {
  test("returns defaults when nothing stored", () => {
    const sizes = loadPaneSizes();
    expect(sizes).toEqual(DEFAULT_SIZES);
  });

  test("returns defaults when stored data is invalid JSON", () => {
    mockLocalStorage.setItem("grove-pane-sizes", "not json");
    const sizes = loadPaneSizes();
    expect(sizes).toEqual(DEFAULT_SIZES);
  });

  test("saves and loads sidebar width", () => {
    savePaneSizes({ sidebar: 300, chat: 320 });
    const sizes = loadPaneSizes();
    expect(sizes.sidebar).toBe(300);
    expect(sizes.chat).toBe(320);
  });

  test("saves and loads chat width", () => {
    savePaneSizes({ sidebar: 240, chat: 400 });
    const sizes = loadPaneSizes();
    expect(sizes.chat).toBe(400);
  });

  test("persists to localStorage under correct key", () => {
    savePaneSizes({ sidebar: 280, chat: 350 });
    const raw = mockLocalStorage.getItem("grove-pane-sizes");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.sidebar).toBe(280);
    expect(parsed.chat).toBe(350);
  });

  test("clampWidth enforces min/max boundaries", () => {
    expect(clampWidth(100, 160, 480)).toBe(160); // below min
    expect(clampWidth(500, 160, 480)).toBe(480); // above max
    expect(clampWidth(300, 160, 480)).toBe(300); // within range
  });

  test("ignores stored values with missing fields and returns defaults", () => {
    mockLocalStorage.setItem("grove-pane-sizes", JSON.stringify({ sidebar: 300 }));
    const sizes = loadPaneSizes();
    // chat should fall back to default
    expect(sizes.sidebar).toBe(300);
    expect(sizes.chat).toBe(DEFAULT_SIZES.chat);
  });
});
