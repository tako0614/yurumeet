import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSingleSuccessfulQuery,
  assertCreateOnlyPlan,
  assertDomainAbsent,
  assertDomainInventory,
  assertDomainChangeset,
  assertInventoryPage,
  assertPinnedRootDefaults,
  assertStateAddresses,
  assertWorkerScriptAbsent,
  listFilteredDomains,
  loadIntegrationTarget,
  parseIntegrationArgs,
  isApiSuccess,
} from "./deploy-integration.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function target(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meet-integration-test-"));
  dirs.push(dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const pin = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../release.lock.json"), "utf8"),
  ).releases["v0.2.0"];
  const file = join(dir, "target.json");
  writeFileSync(
    file,
    JSON.stringify({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      origin: "https://ga-meet-20261012.yurucommu.com",
      prefix: "yurumeet-ga-20261012-0938",
      releaseTag: "v0.2.0",
      artifactSha256: pin.artifact.sha256.slice(7),
      sourceCommit: "c".repeat(40),
      stateDir,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return { file, dir };
}

test("only the explicit integration phase syntax is accepted", () => {
  expect(
    parseIntegrationArgs(["--environment=integration", "--phase=resources"]),
  ).toBe("resources");
  expect(
    parseIntegrationArgs([
      "--environment=integration",
      "--phase=probe-case-parser",
    ]),
  ).toBe("probe-case-parser");
  for (const args of [
    ["--environment=production", "--phase=resources"],
    ["--environment=integration", "--phase=destroy"],
    ["--environment=integration", "--phase=resources", "--auto-approve"],
  ])
    expect(() => parseIntegrationArgs(args)).toThrow();
});

test("Cloudflare success envelopes accept null errors but fail closed on contradictions", () => {
  const sanitizedQueueResponse = {
    success: true,
    errors: null,
    result: Array.from({ length: 100 }, (_, index) => ({
      queue_name: `queue-${index}`,
    })),
    result_info: {
      page: 1,
      per_page: 100,
      count: 100,
      total_count: 1066,
      total_pages: 11,
    },
  };
  expect(isApiSuccess(sanitizedQueueResponse)).toBe(true);
  for (const success of [undefined, null, false]) {
    expect(isApiSuccess({ success, errors: null })).toBe(false);
  }
  for (const value of [
    { success: true, errors: [{ message: "denied" }] },
    { success: true, errors: {} },
    { success: true, errors: "" },
    { success: true, error: "denied" },
    { success: true, error: {} },
    { success: true, error: false },
  ]) {
    expect(isApiSuccess(value)).toBe(false);
  }
  for (const value of [
    { success: true },
    { success: true, errors: null, error: null },
    { success: true, errors: [], error: "" },
  ]) {
    expect(isApiSuccess(value)).toBe(true);
  }
});

test("target binds exact origin, resource prefix, source and published artifact", () => {
  const good = target();
  const root = readFileSync(resolve(import.meta.dir, "../main.tf"), "utf8");
  const pin = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../release.lock.json"), "utf8"),
  ).releases["v0.2.0"].artifact.sha256.slice(7);
  const url =
    "https://github.com/tako0614/yurumeet/releases/download/v0.2.0/worker.js";
  expect(() =>
    assertPinnedRootDefaults(root, "v0.2.0", url, pin),
  ).not.toThrow();
  const wrongDigestRoot = root.replace(
    `default     = "${pin}"`,
    `default     = "${"0".repeat(64)}"`,
  );
  expect(wrongDigestRoot).not.toBe(root);
  expect(() =>
    assertPinnedRootDefaults(wrongDigestRoot, "v0.2.0", url, pin),
  ).toThrow();
  expect(loadIntegrationTarget(good.file).prefix).toBe(
    "yurumeet-ga-20261012-0938",
  );
  for (const wrong of [
    { origin: "https://test.yurucommu.com" },
    { prefix: "yurumeet" },
    { releaseTag: "v0.2.1" },
    { artifactSha256: "0".repeat(64) },
    { sourceCommit: "HEAD" },
  ])
    expect(() => loadIntegrationTarget(target(wrong).file)).toThrow();
});

test("private target refuses broad permissions and state outside its private tree", () => {
  const loose = target();
  chmodSync(loose.file, 0o644);
  expect(() => loadIntegrationTarget(loose.file)).toThrow();
  const escape = target({ stateDir: "/tmp" });
  expect(() => loadIntegrationTarget(escape.file)).toThrow();
});

test("single-page Worker script inventory checks exact identity without pagination metadata", () => {
  expect(() =>
    assertWorkerScriptAbsent({ result: [{ id: "unrelated" }] }),
  ).not.toThrow();
  expect(() =>
    assertWorkerScriptAbsent({ result: [{ id: "yurumeet-ga-20261012-0938" }] }),
  ).toThrow();
  expect(() =>
    assertWorkerScriptAbsent({ result: [{ script_name: "unrelated" }] }),
  ).toThrow();
  expect(() => assertWorkerScriptAbsent({ result: null })).toThrow();
});

test("OpenTofu plan accepts only exact creates and unchanged predecessors", () => {
  const create = (address: string, actions = ["create"], mode = "managed") => ({
    address,
    mode,
    change: { actions },
  });
  const allowed = new Set(["cloudflare_d1_database.database[0]"]);
  const old = new Set(["random_id.encryption_key"]);
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          create("cloudflare_d1_database.database[0]"),
          create("random_id.encryption_key", ["no-op"]),
        ],
      },
      allowed,
      old,
    ),
  ).not.toThrow();
  for (const actions of [["delete"], ["update"], ["delete", "create"]]) {
    expect(() =>
      assertCreateOnlyPlan(
        {
          resource_changes: [
            create("cloudflare_d1_database.database[0]", actions),
          ],
        },
        allowed,
        old,
      ),
    ).toThrow();
  }
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          create("cloudflare_d1_database.database[0]"),
          create("cloudflare_workers_script.worker[0]"),
        ],
      },
      allowed,
    ),
  ).toThrow();
});

test("custom domain changeset never accepts replacement or DNS conflict", () => {
  const added = [{ hostname: "ga-meet-20261012.yurucommu.com" }];
  const clean = { added, updated: [], deleted: [], conflicting: [] };
  expect(() => assertDomainChangeset(clean)).not.toThrow();
  for (const key of ["updated", "deleted", "conflicting"] as const) {
    expect(() => assertDomainChangeset({ ...clean, [key]: added })).toThrow();
  }
  expect(() =>
    assertDomainChangeset({ ...clean, added: [{ hostname: "yurucommu.com" }] }),
  ).toThrow();
});

test("activated state requires the one exact HTTP data source from explicit URL mode", () => {
  const managed = new Set(["cloudflare_workers_script.worker[0]"]);
  const bundle = "data.http.worker_bundle[0]";
  expect(() =>
    assertStateAddresses([...managed, bundle], managed, true),
  ).not.toThrow();
  expect(() => assertStateAddresses([...managed], managed, true)).toThrow();
  expect(() =>
    assertStateAddresses([...managed, bundle], managed, false),
  ).toThrow();
  expect(() =>
    assertStateAddresses(
      [...managed, "data.http.worker_release_manifest[0]"],
      managed,
      true,
    ),
  ).toThrow();
  expect(() =>
    assertStateAddresses(
      [...managed, bundle, "data.http.foreign[0]"],
      managed,
      true,
    ),
  ).toThrow();
  expect(() =>
    assertStateAddresses(
      [...managed, "cloudflare_d1_database.other[0]", bundle],
      managed,
      true,
    ),
  ).toThrow();
});

test("domain absence requires complete exact hostname and service inventories", () => {
  const empty = {
    result: [],
    result_info: { page: 1, per_page: 0, count: 0, total_count: 0 },
  };
  for (const [field, identity] of [
    ["hostname", "ga-meet-20261012.yurucommu.com"],
    ["service", "yurumeet-ga-20261012-0938"],
  ] as const) {
    expect(() =>
      assertDomainAbsent(
        assertDomainInventory(empty, field, identity).rows,
        field,
      ),
    ).not.toThrow();
    expect(() =>
      assertDomainAbsent(
        assertDomainInventory(
          { ...empty, result_info: { ...empty.result_info, per_page: 100 } },
          field,
          identity,
        ).rows,
        field,
      ),
    ).not.toThrow();
    const collision = {
      result: [{ [field]: identity }],
      result_info: { page: 1, per_page: 100, count: 1, total_count: 1 },
    };
    expect(() =>
      assertDomainAbsent(
        assertDomainInventory(collision, field, identity).rows,
        field,
      ),
    ).toThrow();
  }
  for (const partial of [
    { ...empty, result_info: { ...empty.result_info, page: 2 } },
    { ...empty, result_info: { ...empty.result_info, total_pages: 2 } },
    { ...empty, result_info: { ...empty.result_info, count: 1 } },
    { ...empty, result_info: { ...empty.result_info, per_page: -1 } },
    { ...empty, result_info: { ...empty.result_info, total_count: -1 } },
    { result: [] },
  ])
    expect(() =>
      assertDomainInventory(
        partial,
        "hostname",
        "ga-meet-20261012.yurucommu.com",
      ),
    ).toThrow();
});

test("filtered domain inventory follows every page and refuses collisions", async () => {
  const paths: string[] = [];
  const rows = await listFilteredDomains(
    "a".repeat(32),
    "hostname",
    "ga-meet-20261012.yurucommu.com",
    async (path) => {
      paths.push(path);
      const page = Number(
        new URL(`https://example.test${path}`).searchParams.get("page"),
      );
      return {
        result:
          page === 1
            ? Array.from({ length: 100 }, () => ({
                hostname: "ga-meet-20261012.yurucommu.com",
              }))
            : [{ hostname: "ga-meet-20261012.yurucommu.com" }],
        result_info: {
          page,
          per_page: 100,
          count: page === 1 ? 100 : 1,
          total_count: 101,
        },
      };
    },
  );
  expect(paths).toHaveLength(2);
  expect(
    paths.every((path) =>
      path.includes("hostname=ga-meet-20261012.yurucommu.com"),
    ),
  ).toBe(true);
  expect(rows).toHaveLength(101);
  expect(() => assertDomainAbsent(rows, "hostname")).toThrow();
});

test("filtered domain pagination accepts Cloudflare empty metadata and rejects drift", async () => {
  const empty = await listFilteredDomains(
    "a".repeat(32),
    "hostname",
    "ga-meet-20261012.yurucommu.com",
    async () => ({
      result: [],
      result_info: { page: 1, per_page: 0, count: 0, total_count: 0 },
    }),
  );
  expect(empty).toEqual([]);

  let calls = 0;
  await expect(
    listFilteredDomains(
      "a".repeat(32),
      "service",
      "yurumeet-ga-20261012-0938",
      async () => {
        calls += 1;
        return {
          result: [{ service: "yurumeet-ga-20261012-0938" }],
          result_info: {
            page: calls,
            per_page: 1,
            count: 1,
            total_count: calls === 1 ? 2 : 3,
          },
        };
      },
    ),
  ).rejects.toThrow("changed while paginating");
});

test("inventory pagination rejects repeated pages and contradictory counts", () => {
  expect(() =>
    assertInventoryPage(
      {
        result: [],
        result_info: { page: 1, per_page: 100, count: 0, total_count: 200 },
      },
      2,
      "D1",
    ),
  ).toThrow();
  expect(() =>
    assertInventoryPage(
      {
        result: [{ name: "one" }],
        result_info: { page: 1, per_page: 100, count: 0, total_count: 200 },
      },
      1,
      "D1",
    ),
  ).toThrow();
});

test("activation plan allows only the pinned Worker bundle data source", () => {
  const worker = "cloudflare_workers_script.worker[0]";
  const bundle = "data.http.worker_bundle[0]";
  const manifest = "data.http.worker_release_manifest[0]";
  const allowed = new Set([worker]);
  const expectedReads = new Set([bundle]);
  const entry = (address: string, actions: string[], mode = "managed") => ({
    address,
    mode,
    change: { actions },
  });
  const valid = [entry(worker, ["create"]), entry(bundle, ["read"], "data")];
  expect(() =>
    assertCreateOnlyPlan(
      { resource_changes: valid },
      allowed,
      new Set(),
      expectedReads,
    ),
  ).not.toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      { resource_changes: [entry(worker, ["create"])] },
      allowed,
      new Set(),
      expectedReads,
    ),
  ).not.toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          entry(worker, ["create"]),
          entry(bundle, ["no-op"], "data"),
        ],
      },
      allowed,
      new Set(),
      expectedReads,
    ),
  ).not.toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          entry(worker, ["create"]),
          entry(manifest, ["read"], "data"),
        ],
      },
      allowed,
      new Set(),
      expectedReads,
    ),
  ).toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          entry(worker, ["create"]),
          entry(bundle, ["read"], "data"),
          entry(bundle, ["no-op"], "data"),
        ],
      },
      allowed,
      new Set(),
      expectedReads,
    ),
  ).toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          entry(worker, ["create"]),
          entry(manifest, ["no-op"], "data"),
        ],
      },
      allowed,
      new Set(),
      expectedReads,
    ),
  ).toThrow();
});

test("target and state paths reject symlinked ancestors", () => {
  const good = target();
  const links = mkdtempSync(join(tmpdir(), "meet-integration-links-"));
  chmodSync(links, 0o700);
  dirs.push(links);
  const alias = join(links, "alias");
  symlinkSync(good.dir, alias, "dir");
  expect(() => loadIntegrationTarget(join(alias, "target.json"))).toThrow(
    "link-free path",
  );
  const config = JSON.parse(readFileSync(good.file, "utf8"));
  writeFileSync(
    good.file,
    JSON.stringify({ ...config, stateDir: join(alias, "state") }),
    { mode: 0o600 },
  );
  expect(() => loadIntegrationTarget(good.file)).toThrow("link-free path");
});

test("resource plans admit no bundle data and every plan rejects duplicate or wrong-mode managed addresses", () => {
  const worker = "cloudflare_workers_script.worker[0]";
  const bundle = "data.http.worker_bundle[0]";
  const allowed = new Set([worker]);
  const entry = (address: string, actions: string[], mode = "managed") => ({
    address,
    mode,
    change: { actions },
  });
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [
          entry(worker, ["create"]),
          entry(bundle, ["read"], "data"),
        ],
      },
      allowed,
    ),
  ).toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      { resource_changes: [entry(worker, ["create"], "data")] },
      allowed,
    ),
  ).toThrow();
  expect(() =>
    assertCreateOnlyPlan(
      {
        resource_changes: [entry(worker, ["create"]), entry(worker, ["no-op"])],
      },
      allowed,
      allowed,
    ),
  ).toThrow();
});

test("pre-activation ledger refuses explicit errors even with success and matching rows", () => {
  for (const body of [
    {
      success: true,
      errors: [{ message: "query failed" }],
      result: [{ success: true, results: [] }],
    },
    {
      success: true,
      result: [
        { success: true, errors: [{ message: "query failed" }], results: [] },
      ],
    },
    {
      success: true,
      result: [{ success: true, error: "query failed", results: [] }],
    },
    { success: true, result: [{ success: true }] },
  ])
    expect(() => assertSingleSuccessfulQuery(body)).toThrow();
});

test("empty and malformed Worker identities refuse activation absence", () => {
  for (const result of [[null], [{}], [{ id: "" }], [{ id: 42 }]]) {
    expect(() => assertWorkerScriptAbsent({ result })).toThrow();
  }
});
