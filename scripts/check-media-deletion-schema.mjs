#!/usr/bin/env bun

const D1_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const MEDIA_DELETION_SCHEMA_QUERY = `
SELECT 'column' AS kind, cid AS ordinal, name, type AS detail,
       "notnull" AS required, pk AS position
FROM pragma_table_info('media_blob_deletion_jobs')
UNION ALL
SELECT 'index' AS kind, 0 AS ordinal, name, origin AS detail,
       "unique" AS required, partial AS position
FROM pragma_index_list('media_blob_deletion_jobs')
WHERE name = 'media_blob_deletion_jobs_due_idx'
UNION ALL
SELECT 'index-column' AS kind, seqno AS ordinal, name, '' AS detail,
       0 AS required, cid AS position
FROM pragma_index_info('media_blob_deletion_jobs_due_idx')
ORDER BY kind, ordinal`;

const EXPECTED_COLUMNS = [
  { ordinal: 0, name: "r2_key", detail: "TEXT", required: 1, position: 1 },
  {
    ordinal: 1,
    name: "uploader_ap_id",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    ordinal: 2,
    name: "created_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    ordinal: 3,
    name: "next_attempt_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
];

const EXPECTED_INDEX_COLUMNS = [
  { ordinal: 0, name: "next_attempt_at", position: 3 },
  { ordinal: 1, name: "created_at", position: 2 },
  { ordinal: 2, name: "r2_key", position: 0 },
];

function fail(message, diagnostics = {}) {
  const error = new Error(
    `Core 4.1.11 media deletion schema preflight failed: ${message}`,
  );
  if (diagnostics.stdout !== undefined) error.stdout = diagnostics.stdout;
  if (diagnostics.stderr !== undefined) error.stderr = diagnostics.stderr;
  throw error;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function readWorkerD1Target(configText, configPath) {
  let config;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    fail(
      `realized Wrangler config ${configPath} is not strict JSON: ${error.message}`,
    );
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail(`realized Wrangler config ${configPath} must be a JSON object`);
  }
  if (!Array.isArray(config.d1_databases)) {
    fail(`realized Wrangler config ${configPath} has no d1_databases array`);
  }

  const targets = config.d1_databases.filter(
    (database) =>
      database && typeof database === "object" && database.binding === "DB",
  );
  if (targets.length !== 1) {
    fail(
      `realized Wrangler config must define exactly one D1 binding named DB`,
    );
  }
  const target = targets[0];
  const ambiguousName = config.d1_databases.some(
    (database) => database !== target && database?.database_name === "DB",
  );
  if (ambiguousName) {
    fail(
      `realized Wrangler config has a database_name collision with binding DB`,
    );
  }
  if (
    typeof target.database_name !== "string" ||
    target.database_name.trim() === ""
  ) {
    fail(`D1 binding DB must have a concrete database_name`);
  }
  if (
    typeof target.database_id !== "string" ||
    !D1_ID_RE.test(target.database_id)
  ) {
    fail(`D1 binding DB must have a concrete database_id UUID`);
  }

  return {
    binding: "DB",
    databaseName: target.database_name,
    databaseId: target.database_id,
  };
}

function assertMetadataRows(rows) {
  if (!Array.isArray(rows)) fail("D1 query results are not an array");
  const columns = [];
  const indexes = [];
  const indexColumns = [];

  for (const row of rows) {
    if (
      !exactKeys(row, [
        "kind",
        "ordinal",
        "name",
        "detail",
        "required",
        "position",
      ])
    ) {
      fail("D1 query returned a malformed migration 0030 metadata row");
    }
    if (row.kind === "column") columns.push(row);
    else if (row.kind === "index") indexes.push(row);
    else if (row.kind === "index-column") indexColumns.push(row);
    else fail(`D1 query returned an unknown migration 0030 metadata row kind`);
  }

  const sameRows = (actual, expected, keys) =>
    actual.length === expected.length &&
    actual.every((row, index) =>
      keys.every((key) => row[key] === expected[index][key]),
    );

  if (
    !sameRows(columns, EXPECTED_COLUMNS, [
      "ordinal",
      "name",
      "detail",
      "required",
      "position",
    ])
  ) {
    fail(
      "media_blob_deletion_jobs columns or primary key do not match migration 0030",
    );
  }
  if (
    !sameRows(
      indexes,
      [
        {
          ordinal: 0,
          name: "media_blob_deletion_jobs_due_idx",
          detail: "c",
          required: 0,
          position: 0,
        },
      ],
      ["ordinal", "name", "detail", "required", "position"],
    )
  ) {
    fail(
      "migration 0030 media_blob_deletion_jobs_due_idx is missing or has unexpected index flags",
    );
  }
  if (
    !sameRows(indexColumns, EXPECTED_INDEX_COLUMNS, [
      "ordinal",
      "name",
      "position",
    ]) ||
    indexColumns.some((row) => row.detail !== "" || row.required !== 0)
  ) {
    fail(
      "migration 0030 media_blob_deletion_jobs_due_idx columns or order do not match",
    );
  }
}

function parseQueryResponse(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    fail(`Wrangler returned invalid JSON: ${error.message}`);
  }
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    !exactKeys(result[0], ["results", "success", "meta"]) ||
    result[0].success !== true ||
    !result[0].meta ||
    typeof result[0].meta !== "object" ||
    Array.isArray(result[0].meta)
  ) {
    fail("Wrangler returned an unexpected or unsuccessful D1 query response");
  }
  assertMetadataRows(result[0].results);
}

export function checkMediaDeletionSchema({
  configText,
  configPath,
  cloudflareEnv,
  run,
}) {
  if (typeof run !== "function") fail("command runner is unavailable");
  if (typeof cloudflareEnv === "string" && cloudflareEnv !== "") {
    fail(
      "CLOUDFLARE_ENV selects an environment override that this preflight does not resolve",
    );
  }
  readWorkerD1Target(configText, configPath);
  const args = [
    "d1",
    "execute",
    "DB",
    "--remote",
    "--json",
    "--config",
    configPath,
    "--command",
    MEDIA_DELETION_SCHEMA_QUERY,
  ];
  let stdout;
  try {
    stdout = run("wrangler", args);
  } catch (error) {
    const wrapped = new Error(
      `Core 4.1.11 media deletion schema preflight failed: Wrangler D1 query failed: ${error?.message ?? "unknown CLI error"}`,
    );
    if (error?.stdout !== undefined) wrapped.stdout = error.stdout;
    if (error?.stderr !== undefined) wrapped.stderr = error.stderr;
    throw wrapped;
  }
  if (typeof stdout !== "string") fail("Wrangler output is not text");
  try {
    parseQueryResponse(stdout);
  } catch (error) {
    fail(error.message, { stdout });
  }
  return {
    kind: "yurumeet.core-media-deletion-schema@v1",
    table: "media_blob_deletion_jobs",
    index: "media_blob_deletion_jobs_due_idx",
    scope: "migration-0030-only",
  };
}
