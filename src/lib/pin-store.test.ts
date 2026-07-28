import { describe, expect, test } from "bun:test";
import {
  isPinned,
  PIN_KEY,
  type PinStorage,
  pinnedFirst,
  readPinnedIds,
  togglePin,
} from "./pin-store.ts";

function memoryStore(): PinStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const AP_A = "https://yurume.example/ap/users/alice";
const AP_B = "https://yurume.example/ap/users/bob";
const AP_C = "https://yurume.example/ap/communities/team";

describe("pin-store", () => {
  test("no pins by default", () => {
    const store = memoryStore();
    expect(readPinnedIds(store)).toEqual([]);
    expect(isPinned(AP_A, store)).toBe(false);
  });

  test("toggle pins then unpins a talk", () => {
    const store = memoryStore();
    expect(togglePin(AP_A, store)).toEqual([AP_A]);
    expect(isPinned(AP_A, store)).toBe(true);
    expect(togglePin(AP_A, store)).toEqual([]);
    expect(isPinned(AP_A, store)).toBe(false);
    // Cleared to empty removes the key rather than storing "[]".
    expect(store.map.has(PIN_KEY)).toBe(false);
  });

  test("newly pinned talks append in pin order", () => {
    const store = memoryStore();
    togglePin(AP_A, store);
    togglePin(AP_B, store);
    togglePin(AP_C, store);
    expect(readPinnedIds(store)).toEqual([AP_A, AP_B, AP_C]);
    // Unpinning the middle keeps the rest in order.
    expect(togglePin(AP_B, store)).toEqual([AP_A, AP_C]);
  });

  test("pins persist across reads (round-trips storage)", () => {
    const store = memoryStore();
    togglePin(AP_A, store);
    togglePin(AP_C, store);
    expect(readPinnedIds(store)).toEqual([AP_A, AP_C]);
  });

  test("corrupt storage degrades to no pins", () => {
    const store = memoryStore();
    store.map.set(PIN_KEY, "not json");
    expect(readPinnedIds(store)).toEqual([]);
    store.map.set(PIN_KEY, JSON.stringify({ not: "an array" }));
    expect(readPinnedIds(store)).toEqual([]);
    store.map.set(PIN_KEY, JSON.stringify([AP_A, 42, null, AP_B]));
    expect(readPinnedIds(store)).toEqual([AP_A, AP_B]);
  });

  test("empty ap id is a no-op", () => {
    const store = memoryStore();
    expect(togglePin("", store)).toEqual([]);
    expect(store.map.size).toBe(0);
    expect(isPinned("", store)).toBe(false);
  });

  test("a null store (no localStorage) degrades quietly", () => {
    expect(readPinnedIds(null)).toEqual([]);
    expect(isPinned(AP_A, null)).toBe(false);
    expect(() => togglePin(AP_A, null)).not.toThrow();
  });

  describe("pinnedFirst", () => {
    const rows = [{ ap_id: AP_A }, { ap_id: AP_B }, { ap_id: AP_C }];

    test("returns the input untouched when nothing is pinned", () => {
      const out = pinnedFirst(rows, new Set());
      expect(out).toBe(rows);
    });

    test("moves pinned rows to the top, preserving relative order", () => {
      const out = pinnedFirst(rows, new Set([AP_C]));
      expect(out.map((r) => r.ap_id)).toEqual([AP_C, AP_A, AP_B]);
    });

    test("keeps original order within the pinned and unpinned groups", () => {
      const out = pinnedFirst(rows, new Set([AP_A, AP_C]));
      expect(out.map((r) => r.ap_id)).toEqual([AP_A, AP_C, AP_B]);
    });
  });
});
