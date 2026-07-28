import { describe, expect, test } from "bun:test";
import { searchMessages, splitHighlight } from "./message-search.ts";

const msg = (id: string, content: string | null) => ({ id, content });

describe("searchMessages", () => {
  const messages = [
    msg("a", "こんにちは、元気ですか?"),
    msg("b", "Hello World"),
    msg("c", null),
    msg("d", "hello again"),
    msg("e", "明日の予定を確認したい"),
  ];

  test("empty / whitespace query matches nothing", () => {
    expect(searchMessages(messages, "")).toEqual([]);
    expect(searchMessages(messages, "   ")).toEqual([]);
  });

  test("case-insensitive substring, preserves oldest→newest order", () => {
    expect(searchMessages(messages, "hello")).toEqual(["b", "d"]);
    expect(searchMessages(messages, "HELLO")).toEqual(["b", "d"]);
  });

  test("matches Japanese substrings", () => {
    expect(searchMessages(messages, "予定")).toEqual(["e"]);
    expect(searchMessages(messages, "こんにちは")).toEqual(["a"]);
  });

  test("null content never matches or throws", () => {
    expect(searchMessages(messages, "c")).toEqual([]);
  });

  test("query is trimmed before matching", () => {
    expect(searchMessages(messages, "  world  ")).toEqual(["b"]);
  });

  test("no match yields empty list", () => {
    expect(searchMessages(messages, "見つからない")).toEqual([]);
  });
});

describe("splitHighlight", () => {
  test("empty query returns a single non-hit run", () => {
    expect(splitHighlight("hello", "")).toEqual([
      { text: "hello", hit: false },
    ]);
  });

  test("empty text returns nothing", () => {
    expect(splitHighlight("", "x")).toEqual([]);
  });

  test("splits around a single match, preserving original casing", () => {
    expect(splitHighlight("Say Hello there", "hello")).toEqual([
      { text: "Say ", hit: false },
      { text: "Hello", hit: true },
      { text: " there", hit: false },
    ]);
  });

  test("marks every occurrence", () => {
    expect(splitHighlight("aXaXa", "x")).toEqual([
      { text: "a", hit: false },
      { text: "X", hit: true },
      { text: "a", hit: false },
      { text: "X", hit: true },
      { text: "a", hit: false },
    ]);
  });

  test("match at the very start and end", () => {
    expect(splitHighlight("abcab", "ab")).toEqual([
      { text: "ab", hit: true },
      { text: "c", hit: false },
      { text: "ab", hit: true },
    ]);
  });

  test("no match returns the whole text as one non-hit run", () => {
    expect(splitHighlight("hello", "zzz")).toEqual([
      { text: "hello", hit: false },
    ]);
  });

  test("adjacent matches produce consecutive hit runs", () => {
    expect(splitHighlight("aa", "a")).toEqual([
      { text: "a", hit: true },
      { text: "a", hit: true },
    ]);
  });
});
