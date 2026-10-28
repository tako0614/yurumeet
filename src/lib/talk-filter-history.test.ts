import { expect, mock, test } from "bun:test";

// Router's module initializes browser state before any component mounts. The
// filter seam accepts the entry state through callbacks instead.
mock.module("@solidjs/router", () => ({
  useLocation: () => ({}),
  useNavigate: () => () => {},
}));
const { createTalkListFilterHistory } = await import("./chat-context.tsx");

test("talk filter follows its own browser history entry", () => {
  const entries: Record<string, unknown>[] = [{ _depth: 1 }, { _depth: 2 }];
  let current = 0;
  const filter = createTalkListFilterHistory(
    () => entries[current],
    (state) => {
      entries[current] = state;
    },
    () => "https://example.test|actor|epoch-1",
  );

  filter.write("Akari");
  current = 1;
  expect(filter.read()).toBe("");
  filter.write("Mio");
  current = 0;
  expect(filter.read()).toBe("Akari");
  current = 1;
  expect(filter.read()).toBe("Mio");
});

test("mobile overlay and profile Back keep the original list context", () => {
  const entries: Record<string, unknown>[] = [{ _depth: 1 }];
  let current = 0;
  const filter = createTalkListFilterHistory(
    () => entries[current],
    (state) => {
      entries[current] = state;
    },
    () => "scope-1",
  );

  filter.write("Akari");
  entries.push({ ...entries[0], _depth: 2, yurumeChatOpen: true });
  current = 1;
  expect(filter.read()).toBe("Akari");
  entries.push({ _depth: 3 });
  current = 2;
  expect(filter.read()).toBe("");
  current = 1;
  expect(filter.read()).toBe("Akari");
  expect(entries[1].yurumeChatOpen).toBe(true);
  expect(JSON.stringify(entries[1])).not.toContain("Akari");
});

test("first input preserves router and mobile history state without storing text", () => {
  let entry: Record<string, unknown> = {
    _depth: 7,
    yurumeChatOpen: true,
    otherMarker: "keep-me",
  };
  let replacements = 0;
  const filter = createTalkListFilterHistory(
    () => entry,
    (state) => {
      entry = state;
      replacements++;
    },
    () => "scope-1",
  );

  filter.write("Akari");
  filter.write("Akariko");
  expect(replacements).toBe(1);
  expect(entry._depth).toBe(7);
  expect(entry.yurumeChatOpen).toBe(true);
  expect(entry.otherMarker).toBe("keep-me");
  expect(typeof entry.yurumeTalkFilterEntry).toBe("string");
  expect(JSON.stringify(entry)).not.toContain("Akari");
  expect(filter.read()).toBe("Akariko");
});

test("a router state notification during first input sees the new filter", () => {
  let entry: Record<string, unknown> = { _depth: 1 };
  let notifiedFilter = "";
  const filter = createTalkListFilterHistory(
    () => entry,
    (state) => {
      entry = state;
      notifiedFilter = filter.read();
    },
    () => "scope-1",
  );

  filter.write("Akari");
  expect(notifiedFilter).toBe("Akari");
});

test("origin, actor, and same-actor epoch changes invalidate old entries", () => {
  let scope = JSON.stringify(["https://first.test", "actor-1", 1]);
  let entry: Record<string, unknown> = {};
  const filter = createTalkListFilterHistory(
    () => entry,
    (state) => {
      entry = state;
    },
    () => scope,
  );

  filter.write("Akari");
  const firstMarker = entry.yurumeTalkFilterEntry;
  scope = JSON.stringify(["https://second.test", "actor-1", 1]);
  filter.syncScope();
  expect(filter.read()).toBe("");
  filter.write("Mio");
  expect(entry.yurumeTalkFilterEntry).not.toBe(firstMarker);
  scope = JSON.stringify(["https://second.test", "actor-2", 1]);
  expect(filter.read()).toBe("");
  filter.write("Sora");
  scope = JSON.stringify(["https://second.test", "actor-2", 2]);
  expect(filter.read()).toBe("");
  filter.write("Ren");
  filter.clear();
  expect(filter.read()).toBe("");
});
