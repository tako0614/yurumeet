import { describe, expect, test } from "bun:test";
import { restoreDeletedMessage } from "./restore-deleted-message.ts";

const row = (id: string, created_at: string) => ({ id, created_at });

describe("restoreDeletedMessage", () => {
  test("orders a restored row around a new row between snapshot neighbors", () => {
    const snapshot = [
      row("oldest", "2026-01-01T00:00:01.000Z"),
      row("deleted", "2026-01-01T00:00:02.000Z"),
      row("newest", "2026-01-01T00:00:04.000Z"),
    ];
    const current = [
      row("oldest", "2026-01-01T00:00:01.000Z"),
      row("concurrent", "2026-01-01T00:00:03.000Z"),
      row("newest", "2026-01-01T00:00:04.000Z"),
    ];
    expect(
      restoreDeletedMessage(current, snapshot, "deleted").map((row) => row.id),
    ).toEqual(["oldest", "deleted", "concurrent", "newest"]);
  });

  test("does not duplicate a row already restored by a newer load", () => {
    const snapshot = [
      row("oldest", "2026-01-01T00:00:01.000Z"),
      row("deleted", "2026-01-01T00:00:02.000Z"),
      row("newest", "2026-01-01T00:00:03.000Z"),
    ];
    const current = [
      row("oldest", "2026-01-01T00:00:01.000Z"),
      row("deleted", "2026-01-01T00:00:02.000Z"),
      row("newest", "2026-01-01T00:00:03.000Z"),
      row("concurrent", "2026-01-01T00:00:04.000Z"),
    ];
    expect(restoreDeletedMessage(current, snapshot, "deleted")).toBe(current);
  });

  test("places the row relative to surviving neighbors after a reload", () => {
    const snapshot = [
      row("oldest", "2026-01-01T00:00:01.000Z"),
      row("deleted", "2026-01-01T00:00:02.000Z"),
      row("newest", "2026-01-01T00:00:04.000Z"),
    ];
    const current = [
      row("newest", "2026-01-01T00:00:04.000Z"),
      row("fresh", "2026-01-01T00:00:05.000Z"),
    ];
    expect(
      restoreDeletedMessage(current, snapshot, "deleted").map((row) => row.id),
    ).toEqual(["deleted", "newest", "fresh"]);
  });

  test("uses chronological order and ID ties when no snapshot neighbor survives", () => {
    const snapshot = [
      row("before", "2026-01-01T00:00:01.000Z"),
      row("m-deleted", "2026-01-01T00:00:02.000Z"),
      row("after", "2026-01-01T00:00:03.000Z"),
    ];
    const current = [
      row("z-same-time", "2026-01-01T00:00:02.000Z"),
      row("later", "2026-01-01T00:00:04.000Z"),
    ];
    expect(
      restoreDeletedMessage(current, snapshot, "m-deleted").map(
        (message) => message.id,
      ),
    ).toEqual(["m-deleted", "z-same-time", "later"]);
  });
});
