import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parserProbeTestSupport,
  runCaseParserProbe,
} from "./deploy-integration-parser-probe.mjs";

const dirs: string[] = [];
const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const TOKEN = "parser-probe-token-do-not-log";
const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function diagnosticsDir() {
  const path = mkdtempSync(join(tmpdir(), "meet-case-parser-"));
  chmodSync(path, 0o700);
  dirs.push(path);
  return path;
}

function apiResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value) ?? "null", { status });
}

function schemaRows(database: Database) {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    )
    .all();
}

test("the three probe statements isolate CASE END spelling and retain rollback shape", () => {
  const { variants, buildParserProbeBatch, triggerSql, queryRequestBody } =
    parserProbeTestSupport;
  expect(
    variants.map(({ name, databaseName }) => [name, databaseName]),
  ).toEqual([
    ["bare", "yurumeet-ga-20261012-0938-parser-bare"],
    ["parenthesized", "yurumeet-ga-20261012-0938-parser-parenthesized"],
    ["values", "yurumeet-ga-20261012-0938-parser-values"],
  ]);
  expect(triggerSql("bare")).toContain("SELECT CASE WHEN");
  expect(triggerSql("bare")).toContain("END;\n  INSERT INTO");
  expect(triggerSql("parenthesized")).toContain("SELECT (CASE WHEN");
  expect(triggerSql("parenthesized")).toContain("END);\n  INSERT INTO");
  expect(triggerSql("values")).toContain("VALUES (CASE WHEN");

  for (const { name } of variants) {
    const database = new Database(":memory:");
    const before = schemaRows(database);
    const batch = buildParserProbeBatch(name);
    expect(batch).toHaveLength(7);
    database.exec("BEGIN");
    for (const { sql } of batch.slice(0, 6)) database.exec(sql);
    expect(() => database.exec(batch.at(-1)!.sql)).toThrow(
      /UNIQUE constraint failed/u,
    );
    database.exec("ROLLBACK");
    expect(schemaRows(database)).toEqual(before);
    const request = queryRequestBody(batch);
    expect(request.body.batch).toEqual(batch);
    expect(request.bodyBytes).toBe(request.bytes.length);
    database.close();
  }
});

function mockCloudflare({
  existing = [],
  failBatch = "none",
  residue = false,
  wrongGet = false,
  failCreatedGetTransport = false,
  duplicateCreateUuid = false,
  accountResponseId = ACCOUNT,
  zoneResponseId = ZONE,
  zoneResponseName = "yurucommu.com",
  zoneAccountId = ACCOUNT,
  badCreateEnvelope = false,
  badCreateApiEnvelope = false,
  badInventoryPage = false,
  malformedBatchEnvelope = false,
  echoTokenInBatchResponse = false,
}: {
  existing?: { name: string; uuid: string }[];
  failBatch?: "none" | "transport";
  residue?: boolean;
  wrongGet?: boolean;
  failCreatedGetTransport?: boolean;
  duplicateCreateUuid?: boolean;
  accountResponseId?: string;
  zoneResponseId?: string;
  zoneResponseName?: string;
  zoneAccountId?: string;
  badCreateEnvelope?: boolean;
  badCreateApiEnvelope?: boolean;
  badInventoryPage?: boolean;
  malformedBatchEnvelope?: boolean;
  echoTokenInBatchResponse?: boolean;
} = {}) {
  const databases = [...existing];
  const calls: {
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }[] = [];
  let batchWrites = 0;
  let schemaReads = 0;
  const fetchImpl: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch> = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === "GET" && url.endsWith(`/accounts/${ACCOUNT}`))
      return apiResponse({
        success: true,
        errors: null,
        result: { id: accountResponseId },
      });
    if (method === "GET" && url.endsWith(`/zones/${ZONE}`))
      return apiResponse({
        success: true,
        errors: null,
        result: {
          id: zoneResponseId,
          name: zoneResponseName,
          account: { id: zoneAccountId },
        },
      });
    if (url.includes("/d1/database?") || url.includes("/d1/database?page=")) {
      const perPage = 100;
      const page = Number(new URL(url).searchParams.get("page"));
      const rows = databases.slice((page - 1) * perPage, page * perPage);
      return apiResponse({
        success: true,
        errors: null,
        result: rows,
        result_info: {
          page: badInventoryPage ? page + 1 : page,
          per_page: perPage,
          count: rows.length,
          total_count: databases.length,
        },
      });
    }
    if (url.endsWith("/workers/scripts"))
      return apiResponse({ success: true, errors: null, result: [] });
    if (method === "POST" && url.endsWith("/d1/database")) {
      const name = String(body?.name);
      const index = databases.length - existing.length;
      const uuid = duplicateCreateUuid ? UUIDS[0] : UUIDS[index];
      if (badCreateEnvelope)
        return apiResponse({ success: true, errors: null, result: { name } });
      if (!uuid) throw new Error("mock exhausted deterministic UUIDs");
      if (badCreateApiEnvelope)
        return apiResponse({
          success: true,
          errors: {},
          result: { name, uuid },
        });
      databases.push({ name, uuid });
      return apiResponse({
        success: true,
        errors: null,
        result: { name, uuid },
      });
    }
    const detail = url.match(/\/d1\/database\/([a-f0-9-]+)$/u);
    if (method === "GET" && detail) {
      if (failCreatedGetTransport) throw new Error("account GET disconnected");
      const record = databases.find(({ uuid }) => uuid === detail[1]);
      return apiResponse({
        success: true,
        errors: null,
        result: record && {
          ...record,
          ...(wrongGet ? { name: "different-database" } : {}),
        },
      });
    }
    if (method === "POST" && url.endsWith("/query")) {
      if (body?.sql === parserProbeTestSupport.RAW_SCHEMA_SQL) {
        schemaReads += 1;
        const results =
          residue && schemaReads === 2
            ? [
                {
                  type: "table",
                  name: "probe_residue",
                  tbl_name: "probe_residue",
                  sql: "CREATE TABLE probe_residue(x)",
                },
              ]
            : [];
        return apiResponse({
          success: true,
          errors: null,
          result: [{ success: true, results }],
        });
      }
      batchWrites += 1;
      if (failBatch === "transport") throw new Error("network disconnected");
      if (malformedBatchEnvelope)
        return apiResponse(
          {
            success: false,
            errors: [
              { code: 7500, message: "UNIQUE constraint failed: probe.id" },
              { code: 7501, message: "contradictory second error" },
            ],
            result: [],
          },
          400,
        );
      const trigger = String(body?.batch?.[2]?.sql);
      const echo = echoTokenInBatchResponse
        ? {
            debugEcho: String(
              (init?.headers as Record<string, string> | undefined)
                ?.Authorization ?? "",
            ).slice("Bearer ".length),
          }
        : {};
      if (trigger.includes("SELECT CASE WHEN"))
        return apiResponse(
          {
            success: false,
            errors: [{ code: 7500, message: "incomplete input: SQLITE_ERROR" }],
            result: [],
            ...echo,
          },
          400,
        );
      return apiResponse(
        {
          success: false,
          errors: [
            {
              code: 7500,
              message:
                "UNIQUE constraint failed: __yurumeet_case_parser_probe.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
            },
          ],
          result: [],
          ...echo,
        },
        400,
      );
    }
    throw new Error(`unrecognized mocked Cloudflare request: ${method} ${url}`);
  };
  return {
    fetchImpl,
    calls,
    databases,
    get batchWrites() {
      return batchWrites;
    },
  };
}

test("one exact create and one write per disposable D1; parser result stays diagnostic", async () => {
  const mock = mockCloudflare();
  const result = await runCaseParserProbe({
    accountId: ACCOUNT,
    zoneId: ZONE,
    token: TOKEN,
    diagnosticsDir: diagnosticsDir(),
    fetchImpl: mock.fetchImpl,
  });
  expect(result).toMatchObject({
    phase: "probe-case-parser",
    status: "DIAGNOSTIC_ONLY",
    databaseCount: 3,
    noRetry: true,
    noDelete: true,
    noWorkerOrDomainMutation: true,
  });
  expect(
    result.variants.map(({ variant, outcome }) => [variant, outcome]),
  ).toEqual([
    ["bare", "INCOMPLETE_INPUT_OBSERVED"],
    ["parenthesized", "EXPECTED_LATE_CONSTRAINT_FAILURE"],
    ["values", "EXPECTED_LATE_CONSTRAINT_FAILURE"],
  ]);
  expect(mock.batchWrites).toBe(3);
  expect(
    mock.calls.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/d1/database"),
    ),
  ).toHaveLength(3);
  expect(mock.calls.some(({ method }) => method === "DELETE")).toBe(false);
  expect(
    mock.calls.some(
      ({ method, url }) => method === "PUT" || url.includes("/workers/domains"),
    ),
  ).toBe(false);
  for (const { privateResponse } of result.variants) {
    const stat = lstatSync(privateResponse);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(privateResponse, "utf8")).not.toContain(TOKEN);
  }
});

test("write outcomes require exact HTTP 400, code 7500, and exact expected message", () => {
  const { classifyWrite } = parserProbeTestSupport;
  const expectedUnique = {
    ok: false,
    status: 400,
    value: {
      success: false,
      errors: [
        {
          code: 7500,
          message:
            "UNIQUE constraint failed: __yurumeet_case_parser_probe.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
        },
      ],
      result: [],
    },
  };
  expect(classifyWrite(expectedUnique, "parenthesized")).toBe(
    "EXPECTED_LATE_CONSTRAINT_FAILURE",
  );
  const expectedParser = {
    ok: false,
    status: 400,
    value: {
      success: false,
      errors: [{ code: 7500, message: "incomplete input: SQLITE_ERROR" }],
      result: [],
    },
  };
  expect(classifyWrite(expectedParser, "bare")).toBe(
    "INCOMPLETE_INPUT_OBSERVED",
  );
  for (const malformed of [
    { ...expectedUnique, status: 500 },
    {
      ...expectedUnique,
      value: {
        ...expectedUnique.value,
        errors: [{ ...expectedUnique.value.errors[0]!, code: 7501 }],
      },
    },
    {
      ...expectedUnique,
      value: {
        ...expectedUnique.value,
        errors: [
          {
            code: 7500,
            message:
              "UNIQUE constraint failed: another_table.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
          },
        ],
      },
    },
    {
      ...expectedUnique,
      value: {
        ...expectedUnique.value,
        errors: [
          {
            code: 7500,
            message:
              "UNIQUE constraint failed: __yurumeet_case_parser_probe.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
          },
        ],
      },
    },
    {
      ...expectedUnique,
      value: {
        ...expectedUnique.value,
        errors: [
          {
            code: 7500,
            message:
              "UNIQUE constraint failed: __yurumeet_case_parser_probe_log.marker: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
          },
        ],
      },
    },
  ]) {
    expect(classifyWrite(malformed, "parenthesized")).toBe(
      "UNEXPECTED_D1_FAILURE",
    );
  }
  expect(classifyWrite({ ...expectedParser, status: 500 }, "bare")).toBe(
    "UNEXPECTED_D1_FAILURE",
  );
  expect(
    classifyWrite(
      {
        ...expectedParser,
        value: {
          ...expectedParser.value,
          errors: [{ code: 7501, message: "incomplete input: SQLITE_ERROR" }],
        },
      },
      "bare",
    ),
  ).toBe("UNEXPECTED_D1_FAILURE");
});

test("a preexisting exact target database refuses before Worker inventory or mutation", async () => {
  const existing = {
    name: "yurumeet-ga-20261012-0938-parser-parenthesized",
    uuid: UUIDS[0],
  };
  const mock = mockCloudflare({ existing: [existing] });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/takeover\/reuse is forbidden/u);
  expect(mock.calls.some(({ url }) => url.endsWith("/workers/scripts"))).toBe(
    false,
  );
  expect(mock.calls.some(({ method }) => method === "POST")).toBe(false);
});

test("exact account and zone identity failures stop before database inventory or creation", async () => {
  for (const [mockOptions, expectedMessage] of [
    [{ accountResponseId: "c".repeat(32) }, /exact private target/u],
    [
      { zoneResponseId: "d".repeat(32) },
      /exact account and yurucommu.com target/u,
    ],
    [
      { zoneResponseName: "wrong.example" },
      /exact account and yurucommu.com target/u,
    ],
    [
      { zoneAccountId: "c".repeat(32) },
      /exact account and yurucommu.com target/u,
    ],
  ] as const) {
    const mock = mockCloudflare(mockOptions);
    await expect(
      runCaseParserProbe({
        accountId: ACCOUNT,
        zoneId: ZONE,
        token: TOKEN,
        diagnosticsDir: diagnosticsDir(),
        fetchImpl: mock.fetchImpl,
      }),
    ).rejects.toThrow(expectedMessage);
    expect(mock.calls.some(({ url }) => url.includes("/d1/database"))).toBe(
      false,
    );
    expect(mock.calls.some(({ method }) => method === "POST")).toBe(false);
  }
});

test("incomplete inventory pagination refuses before Worker inventory or mutation", async () => {
  const mock = mockCloudflare({ badInventoryPage: true });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/pagination is incomplete or contradictory/u);
  expect(mock.calls.some(({ url }) => url.endsWith("/workers/scripts"))).toBe(
    false,
  );
  expect(mock.calls.some(({ method }) => method === "POST")).toBe(false);
});

test("malformed create identity is logged privately and never queried or retried", async () => {
  const mock = mockCloudflare({ badCreateEnvelope: true });
  const privateDir = diagnosticsDir();
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: privateDir,
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/exact returned UUID\/name/u);
  expect(
    mock.calls.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/d1/database"),
    ),
  ).toHaveLength(1);
  expect(mock.batchWrites).toBe(0);
  const diagnostics = readdirSync(privateDir).filter((name) =>
    name.endsWith(".json"),
  );
  expect(diagnostics).toHaveLength(1);
  const path = join(privateDir, diagnostics[0]!);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
});

test("created UUID already present in pre-create inventory is refused with create receipt", async () => {
  const mock = mockCloudflare({
    existing: [{ name: "unrelated-existing-database", uuid: UUIDS[0] }],
  });
  const privateDir = diagnosticsDir();
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: privateDir,
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/already present in inventory/u);
  const creates = mock.calls.filter(
    ({ method, url }) => method === "POST" && url.endsWith("/d1/database"),
  );
  expect(creates).toHaveLength(1);
  expect(mock.batchWrites).toBe(0);
  const receipt = readdirSync(privateDir).find((name) =>
    name.includes("create-receipt-bare"),
  );
  expect(receipt).toBeDefined();
  const receiptPath = join(privateDir, receipt!);
  const receiptLog = JSON.parse(readFileSync(receiptPath, "utf8"));
  expect(receiptLog.request.body.name).toBe(
    "yurumeet-ga-20261012-0938-parser-bare",
  );
  expect(receiptLog.response.raw).toContain(UUIDS[0]);
  expect(receiptLog.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(receiptLog.response.rawSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
});

test("created UUID duplicated by an earlier probe database stops without another write", async () => {
  const mock = mockCloudflare({ duplicateCreateUuid: true });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/earlier probe/u);
  expect(
    mock.calls.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/d1/database"),
    ),
  ).toHaveLength(2);
  expect(mock.batchWrites).toBe(1);
  expect(
    mock.calls.filter(
      ({ method, url }) =>
        method === "GET" && /\/d1\/database\/[a-f0-9-]+$/u.test(url),
    ),
  ).toHaveLength(1);
});

test("malformed Cloudflare create envelope is refused before query and never retried", async () => {
  const mock = mockCloudflare({ badCreateApiEnvelope: true });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/D1 create outcome is indeterminate/u);
  expect(
    mock.calls.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/d1/database"),
    ),
  ).toHaveLength(1);
  expect(mock.batchWrites).toBe(0);
});

test("contradictory write envelope is refused after schema readback and before another database", async () => {
  const mock = mockCloudflare({ malformedBatchEnvelope: true });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/MALFORMED_FAILURE_ENVELOPE/u);
  expect(mock.databases).toHaveLength(1);
  expect(mock.batchWrites).toBe(1);
  expect(mock.calls.some(({ method }) => method === "DELETE")).toBe(false);
});

test("uncertain batch transport reconciles schema and stops without another database", async () => {
  const mock = mockCloudflare({ failBatch: "transport" });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/indeterminate after clean schema readback/u);
  expect(mock.databases).toHaveLength(1);
  expect(mock.batchWrites).toBe(1);
  expect(mock.calls.some(({ method }) => method === "DELETE")).toBe(false);
});

test("schema residue stops after the first probe and is never cleaned up", async () => {
  const mock = mockCloudflare({ residue: true });
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: diagnosticsDir(),
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/probe left DDL\/table\/trigger\/ledger residue/u);
  expect(mock.databases).toHaveLength(1);
  expect(mock.batchWrites).toBe(1);
  expect(mock.calls.some(({ method }) => method === "DELETE")).toBe(false);
});

test("wrong exact-name create readback stops before query and never retries create", async () => {
  const mock = mockCloudflare({ wrongGet: true });
  const privateDir = diagnosticsDir();
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: privateDir,
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/readback differs/u);
  expect(
    mock.calls.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/d1/database"),
    ),
  ).toHaveLength(1);
  expect(mock.batchWrites).toBe(0);
  const names = readdirSync(privateDir);
  expect(names.some((name) => name.includes("create-receipt-bare"))).toBe(true);
  expect(names.some((name) => name.includes("get-created-identity-bare"))).toBe(
    true,
  );
});

test("created identity remains in private diagnostics when account GET transport fails", async () => {
  const mock = mockCloudflare({ failCreatedGetTransport: true });
  const privateDir = diagnosticsDir();
  await expect(
    runCaseParserProbe({
      accountId: ACCOUNT,
      zoneId: ZONE,
      token: TOKEN,
      diagnosticsDir: privateDir,
      fetchImpl: mock.fetchImpl,
    }),
  ).rejects.toThrow(/GET .*request failed/u);
  const names = readdirSync(privateDir);
  expect(names.some((name) => name.includes("create-receipt-bare"))).toBe(true);
  expect(names.some((name) => name.includes("get-created-bare"))).toBe(true);
  expect(mock.batchWrites).toBe(0);
});

test("diagnostics redact raw and JSON-escaped token strings before serialization", async () => {
  const mock = mockCloudflare({ echoTokenInBatchResponse: true });
  const privateDir = diagnosticsDir();
  const token = 'secret"\\line\nbreak';
  const result = await runCaseParserProbe({
    accountId: ACCOUNT,
    zoneId: ZONE,
    token,
    diagnosticsDir: privateDir,
    fetchImpl: mock.fetchImpl,
  });
  expect(result.databaseCount).toBe(3);
  const rawToken = token;
  const jsonEscapedToken = JSON.stringify(token).slice(1, -1);
  for (const path of result.variants.map(
    ({ privateResponse }) => privateResponse,
  )) {
    const log = readFileSync(path, "utf8");
    expect(log).not.toContain(rawToken);
    expect(log).not.toContain(jsonEscapedToken);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  }
});
