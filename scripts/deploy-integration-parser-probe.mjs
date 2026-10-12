#!/usr/bin/env bun
// Disposable D1-only parser diagnostic. It never creates a Worker or binds a
// database to a Worker; each database is created once and never deleted/reused.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "yurumeet-ga-20261012-0938";
const LEDGER = "yurucommu_migrations";
const PROBE_TABLE = "__yurumeet_case_parser_probe";
const PROBE_LOG = "__yurumeet_case_parser_probe_log";
const PROBE_LEDGER_MARKER = "__yurumeet_case_parser_probe__";
const RAW_SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name";
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

const VARIANTS = Object.freeze([
  Object.freeze({ name: "bare", databaseName: `${PREFIX}-parser-bare` }),
  Object.freeze({
    name: "parenthesized",
    databaseName: `${PREFIX}-parser-parenthesized`,
  }),
  Object.freeze({ name: "values", databaseName: `${PREFIX}-parser-values` }),
]);

function insist(ok, message) {
  if (!ok) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isApiSuccess(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.success === true &&
    (value.errors === undefined ||
      value.errors === null ||
      (Array.isArray(value.errors) && value.errors.length === 0)) &&
    (value.error === undefined || value.error === null || value.error === "")
  );
}

function validateDiagnosticsDir(path) {
  insist(
    typeof path === "string" && isAbsolute(path),
    "private diagnostics directory path is required",
  );
  const stat = lstatSync(path);
  insist(
    !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      (stat.mode & 0o777) === 0o700,
    "private diagnostics directory must be a link-free 0700 directory",
  );
  const actual = realpathSync(path);
  insist(
    resolve(path) === actual,
    "diagnostics path must not contain symlinks",
  );
  const fromRepo = relative(realpathSync(REPO), actual);
  insist(
    fromRepo.startsWith("..") || isAbsolute(fromRepo),
    "private diagnostics must be outside the source repository",
  );
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: REPO,
    encoding: "utf8",
  });
  insist(common.status === 0, "cannot resolve source Git common directory");
  const fromGitCommon = relative(resolve(REPO, common.stdout.trim()), actual);
  insist(
    fromGitCommon.startsWith("..") || isAbsolute(fromGitCommon),
    "private diagnostics must be outside the source Git common directory",
  );
  for (let at = actual; at !== dirname(at); at = dirname(at)) {
    insist(
      !existsSync(join(at, ".git")),
      "private diagnostics must be outside Git worktrees",
    );
  }
  return actual;
}

function writeDiagnostic(context, label, value) {
  const path = join(
    context.diagnosticsDir,
    `case-parser-${label}-${randomUUID()}.json`,
  );
  const escapedToken = JSON.stringify(context.token).slice(1, -1);
  const redact = (item) => {
    if (typeof item === "string")
      return item
        .split(context.token)
        .join("[REDACTED]")
        .split(escapedToken)
        .join("[REDACTED]");
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, redact(child)]),
      );
    return item;
  };
  const safe = JSON.stringify(redact(value), null, 2);
  writeFileSync(path, `${safe}\n`, { flag: "wx", mode: 0o600 });
  const stat = lstatSync(path);
  insist(
    !stat.isSymbolicLink() &&
      stat.isFile() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600,
    "private diagnostic file did not meet the 0600 contract",
  );
  return path;
}

function readJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function send(context, method, path, body) {
  let response;
  try {
    response = await context.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return {
      transportError:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    return {
      responseReadError:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      status: response.status,
      ok: response.ok,
    };
  }
  return {
    status: response.status,
    ok: response.ok,
    raw,
    value: readJson(raw),
  };
}

function saveExchange(context, label, request, result) {
  const serializedRequest = JSON.stringify(request);
  const responseRaw = result.raw;
  return writeDiagnostic(context, label, {
    request,
    requestSha256: sha256(serializedRequest),
    requestBytes: Buffer.byteLength(serializedRequest, "utf8"),
    response: {
      status: result.status,
      ok: result.ok,
      raw: responseRaw,
      rawSha256:
        typeof responseRaw === "string" ? sha256(responseRaw) : undefined,
      rawBytes:
        typeof responseRaw === "string"
          ? Buffer.byteLength(responseRaw, "utf8")
          : undefined,
      transportError: result.transportError,
      responseReadError: result.responseReadError,
    },
  });
}

async function successfulRequest(context, method, path, body, label) {
  const result = await send(context, method, path, body);
  if (
    result.transportError ||
    result.responseReadError ||
    !result.ok ||
    !isApiSuccess(result.value)
  ) {
    const diagnostic = saveExchange(
      context,
      label,
      { method, path, body },
      result,
    );
    throw new Error(
      `${method} ${path.split("?")[0]} request failed; private diagnostics: ${diagnostic}`,
    );
  }
  return result;
}

function assertD1InventoryPage(result, page, expectedPerPage) {
  const info = result.value?.result_info;
  const rows = result.value?.result;
  insist(
    result.ok && isApiSuccess(result.value) && Array.isArray(rows),
    "D1 inventory response is malformed",
  );
  insist(
    info &&
      info.page === page &&
      info.per_page === expectedPerPage &&
      Number.isInteger(info.total_count) &&
      info.total_count >= 0 &&
      Number.isInteger(info.count) &&
      info.count === rows.length &&
      (rows.length > 0 || page * expectedPerPage >= info.total_count),
    "D1 inventory pagination is incomplete or contradictory",
  );
  insist(
    rows.every(
      (database) =>
        typeof database?.name === "string" &&
        database.name.length > 0 &&
        typeof database.uuid === "string" &&
        UUID_PATTERN.test(database.uuid),
    ),
    "D1 inventory contains a malformed database identity",
  );
  return { rows, info };
}

async function listDatabaseInventory(context) {
  const databases = [];
  const names = new Set();
  const uuids = new Set();
  let totalCount;
  for (let page = 1; page <= 100; page += 1) {
    const path = `/accounts/${context.accountId}/d1/database?page=${page}&per_page=100`;
    const result = await successfulRequest(
      context,
      "GET",
      path,
      undefined,
      "database-list",
    );
    let parsed;
    try {
      parsed = assertD1InventoryPage(result, page, 100);
    } catch (error) {
      const diagnostic = saveExchange(
        context,
        "database-list-page",
        { method: "GET", path },
        result,
      );
      throw new Error(`${error.message}; private diagnostics: ${diagnostic}`);
    }
    if (totalCount !== undefined)
      insist(
        parsed.info.total_count === totalCount,
        "D1 inventory changed while paginating",
      );
    totalCount = parsed.info.total_count;
    for (const database of parsed.rows) {
      insist(
        !names.has(database.name) && !uuids.has(database.uuid),
        "D1 inventory repeated a database across pages",
      );
      names.add(database.name);
      uuids.add(database.uuid);
      databases.push(database);
    }
    insist(
      databases.length <= totalCount,
      "D1 inventory returned more rows than its stable total_count",
    );
    if (databases.length === totalCount) return databases;
  }
  throw new Error("D1 inventory exceeded pagination bound");
}

function assertWorkersAbsent(value, expectedNames) {
  const scripts = value?.result;
  insist(
    Array.isArray(scripts) &&
      scripts.every(
        (script) => typeof script?.id === "string" && script.id.length > 0,
      ),
    "Worker script inventory is malformed",
  );
  const found = scripts.find((script) => expectedNames.includes(script.id));
  insist(
    !found,
    `Worker ${found?.id ?? ""} exists; parser probes require standalone D1 resources`,
  );
}

function assertDatabaseIdentity(body, name, uuid) {
  insist(
    isApiSuccess(body) &&
      body.result?.name === name &&
      body.result?.uuid === uuid,
    "account-scoped D1 readback differs from the exact created database",
  );
}

function triggerSql(variant) {
  const trigger = `__yurumeet_case_parser_${variant}`;
  if (variant === "bare") {
    return `CREATE TRIGGER ${trigger} AFTER INSERT ON ${PROBE_TABLE} BEGIN\n  SELECT CASE WHEN NEW.marker <> 'first' THEN RAISE(ABORT,'probe marker') END;\n  INSERT INTO ${PROBE_LOG}(marker) VALUES (NEW.marker);\nEND;`;
  }
  if (variant === "parenthesized") {
    return `CREATE TRIGGER ${trigger} AFTER INSERT ON ${PROBE_TABLE} BEGIN\n  SELECT (CASE WHEN NEW.marker <> 'first' THEN RAISE(ABORT,'probe marker') END);\n  INSERT INTO ${PROBE_LOG}(marker) VALUES (NEW.marker);\nEND;`;
  }
  if (variant === "values") {
    return `CREATE TRIGGER ${trigger} AFTER INSERT ON ${PROBE_TABLE} BEGIN\n  INSERT INTO ${PROBE_LOG}(marker) VALUES (CASE WHEN NEW.marker = 'first' THEN CASE WHEN NEW.id = 1 THEN NEW.marker ELSE 'other' END ELSE 'other' END);\nEND;`;
  }
  throw new Error("unknown parser probe variant");
}

function buildParserProbeBatch(variant) {
  insist(
    VARIANTS.some((item) => item.name === variant),
    "unknown parser probe variant",
  );
  const ledgerMark = `${PROBE_LEDGER_MARKER}_${variant}`;
  return [
    `CREATE TABLE ${PROBE_TABLE} (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`,
    `CREATE TABLE ${PROBE_LOG} (marker TEXT NOT NULL)`,
    triggerSql(variant),
    `CREATE TABLE ${LEDGER} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL)`,
    `INSERT INTO ${LEDGER} (name, applied_at) VALUES ('${ledgerMark}', '2026-10-12T00:00:00.000Z')`,
    `INSERT INTO ${PROBE_TABLE} (id, marker) VALUES (1, 'first')`,
    `INSERT INTO ${PROBE_TABLE} (id, marker) VALUES (1, 'duplicate')`,
  ].map((sql) => ({ sql }));
}

function sqlManifest(batch) {
  return batch.map(({ sql }, index) => ({
    index,
    bytes: Buffer.byteLength(sql, "utf8"),
    sha256: sha256(sql),
  }));
}

function queryRequestBody(batch) {
  const body = { batch };
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return { body, bytes, bodySha256: sha256(bytes), bodyBytes: bytes.length };
}

function assertQueryEnvelope(value, label) {
  insist(
    isApiSuccess(value) &&
      Array.isArray(value.result) &&
      value.result.length === 1 &&
      value.result[0]?.success === true &&
      (value.result[0]?.errors === undefined ||
        value.result[0]?.errors === null ||
        (Array.isArray(value.result[0]?.errors) &&
          value.result[0].errors.length === 0)) &&
      (value.result[0]?.error === undefined ||
        value.result[0]?.error === null ||
        value.result[0]?.error === "") &&
      Array.isArray(value.result[0]?.results),
    `${label} did not return exactly one successful D1 query result`,
  );
  return value.result[0].results;
}

function canonicalSchema(rows) {
  insist(Array.isArray(rows), "D1 sqlite_master result is malformed");
  const normalized = rows.map((row) => {
    insist(
      row &&
        typeof row === "object" &&
        typeof row.type === "string" &&
        typeof row.name === "string" &&
        typeof row.tbl_name === "string" &&
        (row.sql === null || typeof row.sql === "string"),
      "D1 sqlite_master returned a malformed schema row",
    );
    return {
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql,
    };
  });
  normalized.sort((left, right) =>
    `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`),
  );
  return normalized;
}

function assertFreshSchema(rows) {
  const schema = canonicalSchema(rows);
  for (const row of schema) {
    insist(
      row.name.startsWith("sqlite_") ||
        (row.type === "table" &&
          (row.name === "_cf_KV" || row.name === "_cf_METADATA")),
      `D1 is not fresh; unexpected ${row.type} ${row.name}`,
    );
  }
  return schema;
}

function assertSchemaUnchanged(before, after) {
  const beforeRows = canonicalSchema(before);
  const afterRows = canonicalSchema(after);
  insist(
    JSON.stringify(afterRows) === JSON.stringify(beforeRows),
    "probe left DDL/table/trigger/ledger residue; stop without cleanup or next case",
  );
  return afterRows;
}

async function readRawSchema(context, databaseId, label) {
  const path = `/accounts/${context.accountId}/d1/database/${databaseId}/query`;
  const result = await successfulRequest(
    context,
    "POST",
    path,
    { sql: RAW_SCHEMA_SQL },
    label,
  );
  return assertQueryEnvelope(result.value, label);
}

function errorItems(value) {
  const items = [];
  if (Array.isArray(value?.errors)) items.push(...value.errors);
  if (value?.error !== undefined && value.error !== null && value.error !== "")
    items.push({ message: value.error });
  if (Array.isArray(value?.result)) {
    for (const result of value.result) {
      if (Array.isArray(result?.errors)) items.push(...result.errors);
      if (
        result?.error !== undefined &&
        result.error !== null &&
        result.error !== ""
      )
        items.push({ message: result.error });
    }
  }
  return items;
}

function classifyWrite(result, variant) {
  if (result.transportError || result.responseReadError || !result.value)
    return "TRANSPORT_UNCERTAIN";
  const value = result.value;
  if (
    value.success !== false ||
    !Array.isArray(value.errors) ||
    value.errors.length !== 1 ||
    (value.error !== undefined && value.error !== null && value.error !== "") ||
    (value.messages !== undefined &&
      (!Array.isArray(value.messages) || value.messages.length !== 0)) ||
    (value.result !== undefined &&
      value.result !== null &&
      (!Array.isArray(value.result) || value.result.length !== 0))
  )
    return "MALFORMED_FAILURE_ENVELOPE";
  const errors = errorItems(value);
  const error = errors[0];
  if (result.status !== 400 || result.ok !== false)
    return "UNEXPECTED_D1_FAILURE";
  if (
    variant === "bare" &&
    error?.code === 7500 &&
    error?.message === "incomplete input: SQLITE_ERROR"
  ) {
    return "INCOMPLETE_INPUT_OBSERVED";
  }
  const expectedConstraintMessages = new Set([
    `UNIQUE constraint failed: ${PROBE_TABLE}.id: SQLITE_CONSTRAINT`,
    `UNIQUE constraint failed: ${PROBE_TABLE}.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`,
    `PRIMARY KEY constraint failed: ${PROBE_TABLE}.id: SQLITE_CONSTRAINT`,
    `PRIMARY KEY constraint failed: ${PROBE_TABLE}.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`,
  ]);
  if (error?.code === 7500 && expectedConstraintMessages.has(error.message)) {
    return "EXPECTED_LATE_CONSTRAINT_FAILURE";
  }
  return "UNEXPECTED_D1_FAILURE";
}

async function runVariant(context, databaseId, variant) {
  const beforeRows = await readRawSchema(
    context,
    databaseId,
    `schema-before-${variant.name}`,
  );
  const baseline = assertFreshSchema(beforeRows);
  const batch = buildParserProbeBatch(variant.name);
  const request = queryRequestBody(batch);
  const response = await send(
    context,
    "POST",
    `/accounts/${context.accountId}/d1/database/${databaseId}/query`,
    request.body,
  );
  const outcome = classifyWrite(response, variant.name);
  const diagnosticPath = saveExchange(
    context,
    `write-${variant.name}`,
    {
      variant: variant.name,
      databaseName: variant.databaseName,
      databaseId,
      requestPath: `/accounts/${context.accountId}/d1/database/${databaseId}/query`,
      method: "POST",
      bodySha256: request.bodySha256,
      bodyBytes: request.bodyBytes,
      statements: sqlManifest(batch),
    },
    response,
  );
  let afterRows;
  try {
    afterRows = await readRawSchema(
      context,
      databaseId,
      `schema-after-${variant.name}`,
    );
  } catch (error) {
    error.phase = "POST_PARSER_PROBE_INDETERMINATE";
    error.diagnosticPath = diagnosticPath;
    throw error;
  }
  assertSchemaUnchanged(baseline, afterRows);
  if (outcome === "TRANSPORT_UNCERTAIN") {
    throw new Error(
      `probe transport outcome is indeterminate after clean schema readback; stop without another case; private diagnostics: ${diagnosticPath}`,
    );
  }
  if (outcome === "INCOMPLETE_INPUT_OBSERVED" && variant.name === "bare") {
    return {
      variant: variant.name,
      databaseName: variant.databaseName,
      databaseId,
      outcome,
      schemaReadback: "UNCHANGED",
      bodySha256: request.bodySha256,
      bodyBytes: request.bodyBytes,
      statementManifest: sqlManifest(batch),
      privateResponse: diagnosticPath,
    };
  }
  if (outcome !== "EXPECTED_LATE_CONSTRAINT_FAILURE") {
    throw new Error(
      `${variant.name} parser probe returned ${outcome}; stop without cleanup or next case; private diagnostics: ${diagnosticPath}`,
    );
  }
  return {
    variant: variant.name,
    databaseName: variant.databaseName,
    databaseId,
    outcome,
    schemaReadback: "UNCHANGED",
    bodySha256: request.bodySha256,
    bodyBytes: request.bodyBytes,
    statementManifest: sqlManifest(batch),
    privateResponse: diagnosticPath,
  };
}

async function createDisposableDatabase(context, variant, knownUUIDs) {
  const createPath = `/accounts/${context.accountId}/d1/database`;
  context.mutationStarted = true;
  const created = await send(context, "POST", createPath, {
    name: variant.databaseName,
  });
  if (
    created.transportError ||
    created.responseReadError ||
    !created.ok ||
    !isApiSuccess(created.value)
  ) {
    const diagnostic = saveExchange(
      context,
      `create-${variant.name}`,
      {
        method: "POST",
        path: createPath,
        body: { name: variant.databaseName },
      },
      created,
    );
    throw new Error(
      `D1 create outcome is indeterminate; no retry or cleanup; private diagnostics: ${diagnostic}`,
    );
  }
  const uuid = created.value.result?.uuid;
  if (
    typeof uuid !== "string" ||
    !UUID_PATTERN.test(uuid) ||
    created.value.result?.name !== variant.databaseName
  ) {
    const diagnostic = saveExchange(
      context,
      `create-identity-${variant.name}`,
      {
        method: "POST",
        path: createPath,
        body: { name: variant.databaseName },
      },
      created,
    );
    throw new Error(
      `D1 create response lacks the exact returned UUID/name; stop without retry; private diagnostics: ${diagnostic}`,
    );
  }
  const createReceipt = saveExchange(
    context,
    `create-receipt-${variant.name}`,
    {
      method: "POST",
      path: createPath,
      body: { name: variant.databaseName },
    },
    created,
  );
  if (knownUUIDs.has(uuid)) {
    throw new Error(
      `D1 create returned a UUID already present in inventory or an earlier probe; stop without retry; private diagnostics: ${createReceipt}`,
    );
  }
  knownUUIDs.add(uuid);
  const getPath = `/accounts/${context.accountId}/d1/database/${uuid}`;
  const detail = await successfulRequest(
    context,
    "GET",
    getPath,
    undefined,
    `get-created-${variant.name}`,
  );
  try {
    assertDatabaseIdentity(detail.value, variant.databaseName, uuid);
  } catch (error) {
    const diagnostic = saveExchange(
      context,
      `get-created-identity-${variant.name}`,
      { method: "GET", path: getPath },
      detail,
    );
    throw new Error(
      `${error.message}; create receipt: ${createReceipt}; private diagnostics: ${diagnostic}`,
    );
  }
  return uuid;
}

async function workerScripts(context) {
  const path = `/accounts/${context.accountId}/workers/scripts`;
  const result = await successfulRequest(
    context,
    "GET",
    path,
    undefined,
    "worker-inventory",
  );
  return result.value;
}

async function verifyAccountAndZone(context) {
  const accountPath = `/accounts/${context.accountId}`;
  const account = await successfulRequest(
    context,
    "GET",
    accountPath,
    undefined,
    "account-identity",
  );
  if (account.value.result?.id !== context.accountId) {
    const diagnostic = saveExchange(
      context,
      "account-identity-mismatch",
      { method: "GET", path: accountPath },
      account,
    );
    throw new Error(
      `Cloudflare account readback differs from the exact private target; private diagnostics: ${diagnostic}`,
    );
  }

  const zonePath = `/zones/${context.zoneId}`;
  const zone = await successfulRequest(
    context,
    "GET",
    zonePath,
    undefined,
    "zone-identity",
  );
  if (
    zone.value.result?.id !== context.zoneId ||
    zone.value.result?.name !== "yurucommu.com" ||
    zone.value.result?.account?.id !== context.accountId
  ) {
    const diagnostic = saveExchange(
      context,
      "zone-identity-mismatch",
      { method: "GET", path: zonePath },
      zone,
    );
    throw new Error(
      `Cloudflare zone readback differs from the exact account and yurucommu.com target; private diagnostics: ${diagnostic}`,
    );
  }
}

/** Run three one-write parser probes on newly created, standalone integration D1s. */
export async function runCaseParserProbe({
  accountId,
  zoneId,
  token,
  diagnosticsDir,
  fetchImpl = fetch,
}) {
  insist(
    /^[a-f0-9]{32}$/u.test(accountId ?? ""),
    "exact integration account ID required",
  );
  insist(
    /^[a-f0-9]{32}$/u.test(zoneId ?? ""),
    "exact integration zone ID required",
  );
  insist(
    typeof token === "string" && token.length > 0,
    "ephemeral Cloudflare API token required",
  );
  insist(typeof fetchImpl === "function", "fetch implementation is required");
  const context = {
    accountId,
    zoneId,
    token,
    diagnosticsDir: validateDiagnosticsDir(diagnosticsDir),
    fetchImpl,
    mutationStarted: false,
  };
  try {
    await verifyAccountAndZone(context);
    const inventory = await listDatabaseInventory(context);
    const knownUUIDs = new Set(inventory.map(({ uuid }) => uuid));
    for (const variant of VARIANTS) {
      insist(
        !inventory.some((database) => database.name === variant.databaseName),
        `D1 ${variant.databaseName} already exists; takeover/reuse is forbidden`,
      );
    }
    const scripts = await workerScripts(context);
    assertWorkersAbsent(scripts, [
      PREFIX,
      ...VARIANTS.map((variant) => variant.databaseName),
    ]);

    const results = [];
    for (const variant of VARIANTS) {
      if (results.length > 0) {
        const latestInventory = await listDatabaseInventory(context);
        insist(
          !latestInventory.some(
            (database) => database.name === variant.databaseName,
          ),
          `D1 ${variant.databaseName} appeared before its one-time create; takeover/reuse is forbidden`,
        );
        for (const database of latestInventory) knownUUIDs.add(database.uuid);
      }
      const databaseId = await createDisposableDatabase(
        context,
        variant,
        knownUUIDs,
      );
      const outcome = await runVariant(context, databaseId, variant);
      results.push(outcome);
    }
    return {
      phase: "probe-case-parser",
      status: "DIAGNOSTIC_ONLY",
      databaseCount: results.length,
      variants: results,
      noRetry: true,
      noDelete: true,
      noWorkerOrDomainMutation: true,
    };
  } catch (error) {
    if (!error.phase)
      error.phase = context.mutationStarted
        ? "POST_PARSER_PROBE_INDETERMINATE"
        : "PRE_MUTATION_FAILURE";
    throw error;
  }
}

export const parserProbeTestSupport = Object.freeze({
  variants: VARIANTS,
  buildParserProbeBatch,
  triggerSql,
  queryRequestBody,
  sqlManifest,
  isApiSuccess,
  assertD1InventoryPage,
  assertDatabaseIdentity,
  assertFreshSchema,
  assertSchemaUnchanged,
  classifyWrite,
  RAW_SCHEMA_SQL,
});
