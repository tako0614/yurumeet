import { expect, mock, test } from "bun:test";
// Reconciliation is pure; the router initializes browser state at import time.
mock.module("@solidjs/router", () => ({
  useLocation: () => ({}),
  useNavigate: () => () => {},
}));
const { reconcileFetchedWindow } = await import("./chat-context.tsx");
import type { ChatMessage } from "./chat-context.tsx";
const row = (id: string, at: string, content = id): ChatMessage => ({
  id,
  content,
  created_at: at,
  sender: {
    ap_id: "https://example.test/users/owner",
    username: "owner",
    preferred_username: "owner",
    name: "Owner",
    icon_url: null,
  },
});
const options = (rows: readonly ChatMessage[], hasMore = false) => ({
  requestedIds: new Set(rows.map((message) => message.id)),
  hasMore,
});
const ids = (rows: ChatMessage[]) => rows.map((message) => message.id);
test("a successful empty whole-history page removes remotely deleted rows", () => {
  const before = [row("only", "2026-11-01T00:00:00Z")];
  expect(reconcileFetchedWindow(before, [], options(before))).toEqual([]);
});
test("a newest-page poll removes a deleted newest row present when the read started", () => {
  const older = row("old", "2026-11-01T00:00:00Z"),
    middle = row("middle", "2026-11-02T00:00:00Z"),
    newest = row("new", "2026-11-03T00:00:00Z");
  const before = [older, middle, newest];
  expect(
    ids(reconcileFetchedWindow(before, [middle], options(before, true))),
  ).toEqual(["old", "middle"]);
});
test("a complete history page removes deleted rows below its new oldest boundary", () => {
  const older = row("old", "2026-11-01T00:00:00Z"),
    newest = row("new", "2026-11-03T00:00:00Z");
  expect(
    ids(
      reconcileFetchedWindow(
        [older, newest],
        [newest],
        options([older, newest]),
      ),
    ),
  ).toEqual(["new"]);
});
test("empty history preserves pending, failed and rows added after the request started", () => {
  const old = row("old", "2026-11-01T00:00:00Z"),
    pending = { ...row("pending", "2026-11-02T00:00:00Z"), pending: true },
    failed = { ...row("failed", "2026-11-03T00:00:00Z"), failed: true },
    late = row("late", "2026-11-04T00:00:00Z");
  expect(
    ids(
      reconcileFetchedWindow(
        [old, pending, failed, late],
        [],
        options([old, pending, failed]),
      ),
    ),
  ).toEqual(["pending", "failed", "late"]);
});
test("an in-flight page cannot erase a new row inside its timestamp window", () => {
  const first = row("a", "2026-11-01T00:00:00Z"),
    last = row("z", "2026-11-03T00:00:00Z"),
    late = row("m", "2026-11-02T00:00:00Z");
  expect(
    ids(
      reconcileFetchedWindow(
        [first, late, last],
        [first, last],
        options([first, last], true),
      ),
    ),
  ).toEqual(["a", "m", "z"]);
});
test("an inconsistent empty partial page does not authorize removals", () => {
  const before = [row("old", "2026-11-01T00:00:00Z")];
  expect(reconcileFetchedWindow(before, [], options(before, true))).toBe(
    before,
  );
});
test("unchanged pages retain the same array and row references", () => {
  const old = row("a", "2026-11-01T00:00:00Z"),
    newest = row("z", "2026-11-03T00:00:00Z"),
    before = [old, newest];
  expect(
    reconcileFetchedWindow(before, [{ ...newest }], options(before, true)),
  ).toBe(before);
});
test("current server edits replace their row and append new messages", () => {
  const old = row("a", "2026-11-01T00:00:00Z"),
    edited = { ...old, content: "updated" },
    fresh = row("b", "2026-11-02T00:00:00Z");
  expect(
    reconcileFetchedWindow([old], [edited, fresh], options([old])),
  ).toEqual([edited, fresh]);
});
test("same-time IDs retain the server's composite oldest boundary", () => {
  const time = "2026-11-01T00:00:00Z",
    a = row("a", time),
    b = row("b", time),
    c = row("c", time);
  expect(
    ids(reconcileFetchedWindow([a, b, c], [b], options([a, b, c], true))),
  ).toEqual(["a", "b"]);
});
