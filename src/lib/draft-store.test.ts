import { describe, expect, test } from "bun:test";
import {
  clearDraft,
  type DraftStorage,
  draftKey,
  readDraft,
  writeDraft,
} from "./draft-store.ts";

function memoryStore(): DraftStorage & { map: Map<string, string> } {
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

describe("draft-store", () => {
  test("read of an unknown talk is empty", () => {
    const store = memoryStore();
    expect(readDraft(AP_A, store)).toBe("");
  });

  test("write then read round-trips per talk", () => {
    const store = memoryStore();
    writeDraft(AP_A, "書きかけ", store);
    writeDraft(AP_B, "another draft", store);
    expect(readDraft(AP_A, store)).toBe("書きかけ");
    expect(readDraft(AP_B, store)).toBe("another draft");
  });

  test("writing empty / whitespace-only clears the draft", () => {
    const store = memoryStore();
    writeDraft(AP_A, "hi", store);
    expect(readDraft(AP_A, store)).toBe("hi");
    writeDraft(AP_A, "   ", store);
    expect(readDraft(AP_A, store)).toBe("");
    expect(store.map.has(draftKey(AP_A))).toBe(false);
  });

  test("non-empty text preserves surrounding whitespace", () => {
    const store = memoryStore();
    writeDraft(AP_A, "hello ", store);
    expect(readDraft(AP_A, store)).toBe("hello ");
  });

  test("clearDraft removes only the target talk", () => {
    const store = memoryStore();
    writeDraft(AP_A, "a", store);
    writeDraft(AP_B, "b", store);
    clearDraft(AP_A, store);
    expect(readDraft(AP_A, store)).toBe("");
    expect(readDraft(AP_B, store)).toBe("b");
  });

  test("empty ap id is a no-op", () => {
    const store = memoryStore();
    writeDraft("", "x", store);
    expect(store.map.size).toBe(0);
    expect(readDraft("", store)).toBe("");
  });

  test("a null store (no localStorage) degrades quietly", () => {
    expect(readDraft(AP_A, null)).toBe("");
    expect(() => writeDraft(AP_A, "x", null)).not.toThrow();
    expect(() => clearDraft(AP_A, null)).not.toThrow();
  });

  test("keys are namespaced per talk", () => {
    expect(draftKey(AP_A)).toBe(`yurume:draft:${AP_A}`);
  });
});
