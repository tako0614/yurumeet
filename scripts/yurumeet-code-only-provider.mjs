import { createHash } from "node:crypto";
import {
  MEDIA_DELETION_SCHEMA_QUERY,
  validateMediaDeletionQueryResults,
} from "./check-media-deletion-schema.mjs";

const API = "https://api.cloudflare.com/client/v4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{32}$/i;
const WORKER = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_BODY = 128 * 1024;
const MAX_BUNDLE = 64 * 1024 * 1024;
const CONTENT_OVERHEAD = 64 * 1024;
const TIMEOUT_MS = 15_000;
const VERSION_FIELDS = new Set([
  "id",
  "number",
  "metadata",
  "annotations",
  "resources",
]);
const RESOURCE_FIELDS = new Set(["bindings", "script", "script_runtime"]);
const RUNTIME_FIELDS = new Set([
  "compatibility_date",
  "compatibility_flags",
  "exports",
  "limits",
  "migration_tag",
  "usage_model",
  "cache_options",
  "placement",
]);
const SETTINGS_FIELDS = new Set([
  "annotations",
  "bindings",
  "cache_options",
  "compatibility_date",
  "compatibility_flags",
  "exports_reconciliation",
  "limits",
  "logpush",
  "observability",
  "placement",
  "tags",
  "tail_consumers",
  "usage_model",
  "migration_tag",
]);
const SCRIPT_SETTINGS_FIELDS = new Set([
  "logpush",
  "observability",
  "tags",
  "tail_consumers",
]);
const BINDING_TYPES = new Set([
  "d1",
  "kv_namespace",
  "r2_bucket",
  "queue",
  "secret_text",
  "plain_text",
  "json",
  "assets",
]);
const BINDING_FIELDS = {
  d1: new Set(["name", "type", "database_id", "id"]),
  kv_namespace: new Set(["name", "type", "namespace_id"]),
  r2_bucket: new Set(["name", "type", "bucket_name", "jurisdiction"]),
  queue: new Set(["name", "type", "queue_name"]),
  secret_text: new Set(["name", "type", "text"]),
  plain_text: new Set(["name", "type", "text"]),
  json: new Set(["name", "type", "json"]),
  assets: new Set(["name", "type"]),
};

export class YurumeetProviderFailure extends Error {
  constructor(
    message,
    {
      phase = "PRE_UPLOAD_FAILURE",
      operation,
      status,
      codes,
      diagnostic,
      recovery,
    } = {},
  ) {
    super(message);
    this.name = "YurumeetProviderFailure";
    this.phase = phase;
    if (operation) this.operation = operation;
    if (status) this.status = status;
    if (codes?.length) this.codes = codes;
    if (diagnostic) this.diagnostic = diagnostic;
    if (recovery) this.recovery = recovery;
  }
}

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function refuse(message) {
  throw new YurumeetProviderFailure(message);
}
function knownKeys(value, allowed, label) {
  if (!object(value)) refuse(`${label} is missing or malformed`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(`${label} contains an unreviewed field`);
  }
}
function normalizedDate(value) {
  return typeof value === "string" ? value.slice(0, 10) : value;
}
function requireUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value))
    refuse(`${label} is not a UUID`);
  return value;
}
function bindingMap(raw) {
  const map = new Map();
  const entries = Array.isArray(raw)
    ? raw
    : object(raw)
      ? Object.entries(raw).map(([name, value]) => {
          if (
            !object(value) ||
            (value.name !== undefined && value.name !== name)
          ) {
            refuse("Worker binding map contains a conflicting name");
          }
          return { ...value, name };
        })
      : null;
  if (!entries || entries.length === 0)
    refuse("active Version exposes no authoritative bindings");
  for (const binding of entries) {
    if (
      !object(binding) ||
      typeof binding.name !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.name) ||
      typeof binding.type !== "string" ||
      !BINDING_TYPES.has(binding.type) ||
      map.has(binding.name)
    ) {
      refuse("active Version contains a malformed or duplicate binding");
    }
    knownKeys(binding, BINDING_FIELDS[binding.type], "Worker binding");
    if (
      binding.type === "d1" &&
      binding.id !== undefined &&
      binding.id !== binding.database_id
    ) {
      refuse("D1 binding has conflicting physical identifiers");
    }
    map.set(binding.name, binding);
  }
  return map;
}
function normalizedBindings(raw) {
  return [...bindingMap(raw).values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(canonical);
}
function requireBinding(bindings, name, type) {
  const binding = bindings.get(name);
  if (!binding || binding.type !== type)
    refuse(
      "active Version is missing a required binding or has the wrong type",
    );
  return binding;
}
function requirePhysical(value, label) {
  if (typeof value !== "string" || !value.trim())
    refuse(`active Version lacks ${label}`);
  return value;
}
function validateBindings(
  bindings,
  requiredSecretNames,
  config,
  matchConfig = true,
) {
  const db = requireBinding(bindings, "DB", "d1");
  const databaseId = requireUuid(
    db.database_id,
    "active Version DB database_id",
  );
  requireBinding(bindings, "YURUCOMMU_SESSION_HASH_SALT", "secret_text");
  requireBinding(bindings, "ENCRYPTION_KEY", "secret_text");
  if (
    !Array.isArray(requiredSecretNames) ||
    requiredSecretNames.some((name) => typeof name !== "string" || !name)
  ) {
    refuse("required Secret names are missing or malformed");
  }
  for (const name of requiredSecretNames)
    requireBinding(bindings, name, "secret_text");
  const declaredDb =
    config?.d1_databases?.filter((entry) => entry?.binding === "DB") ?? [];
  if (
    declaredDb.length !== 1 ||
    (matchConfig && declaredDb[0].database_id !== databaseId)
  ) {
    refuse("realized config DB differs from the active Version physical DB");
  }
  for (const entry of config.kv_namespaces ?? []) {
    const binding = requireBinding(bindings, entry.binding, "kv_namespace");
    requirePhysical(binding.namespace_id, "namespace_id");
    if (
      matchConfig &&
      entry.id !== undefined &&
      entry.id !== binding.namespace_id
    )
      refuse("KV namespace differs from realized config");
  }
  for (const entry of config.r2_buckets ?? []) {
    const binding = requireBinding(bindings, entry.binding, "r2_bucket");
    requirePhysical(binding.bucket_name, "bucket_name");
    if (
      matchConfig &&
      entry.bucket_name !== undefined &&
      entry.bucket_name !== binding.bucket_name
    )
      refuse("R2 bucket differs from realized config");
    if (
      matchConfig &&
      entry.jurisdiction !== undefined &&
      entry.jurisdiction !== binding.jurisdiction
    ) {
      refuse("R2 jurisdiction differs from realized config");
    }
  }
  for (const entry of config.queues?.producers ?? []) {
    const binding = requireBinding(bindings, entry.binding, "queue");
    requirePhysical(binding.queue_name, "queue_name");
    if (matchConfig && entry.queue !== binding.queue_name)
      refuse("Queue producer differs from realized config");
  }
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    const binding = requireBinding(
      bindings,
      name,
      typeof value === "string" ? "plain_text" : "json",
    );
    const observed =
      binding.type === "plain_text" ? binding.text : binding.json;
    if (matchConfig && (observed === undefined || !equal(observed, value)))
      refuse("active Version variable differs from realized config");
  }
  return databaseId;
}
function versionClosure(version) {
  knownKeys(version, VERSION_FIELDS, "Worker Version");
  requireUuid(version.id, "Worker Version id");
  knownKeys(version.resources, RESOURCE_FIELDS, "Worker Version resources");
  knownKeys(
    version.resources.script,
    new Set(["etag", "handlers", "named_handlers", "last_deployed_from"]),
    "Worker Version script",
  );
  if (
    typeof version.resources.script.etag !== "string" ||
    !version.resources.script.etag ||
    version.resources.script.etag.length > 256
  ) {
    refuse("Worker Version lacks a bounded opaque script etag");
  }
  knownKeys(
    version.resources.script_runtime,
    RUNTIME_FIELDS,
    "Worker Version runtime",
  );
  validateRuntimeFields(version.resources.script_runtime);
  const bindings = bindingMap(version.resources.bindings);
  // Yurumeet has no Durable Object lifecycle. An unexpected export cannot be treated as a code-only update.
  const exports = version.resources.script_runtime.exports;
  if (
    exports !== undefined &&
    (!object(exports) ||
      Object.entries(exports).some(
        ([name, entry]) =>
          name !== "default" ||
          !object(entry) ||
          entry.type !== "worker" ||
          (entry.state !== undefined && entry.state !== "created"),
      ))
  ) {
    refuse("Worker Version declares an unsupported export lifecycle");
  }
  if (version.resources.script_runtime.migration_tag !== undefined)
    refuse("Worker Version declares a migration tag");
  return {
    closure: canonical({
      bindings: normalizedBindings(version.resources.bindings),
      runtime: version.resources.script_runtime,
    }),
    bindings,
    etag: version.resources.script.etag,
  };
}
function validateRuntimeFields(runtime) {
  if (runtime.limits !== undefined)
    knownKeys(
      runtime.limits,
      new Set(["cpu_ms", "subrequests"]),
      "Worker limits",
    );
  if (runtime.cache_options !== undefined)
    knownKeys(
      runtime.cache_options,
      new Set(["enabled", "cross_version_cache"]),
      "Worker cache options",
    );
  if (runtime.placement !== undefined)
    knownKeys(
      runtime.placement,
      new Set(["mode", "region", "hostname", "host", "target"]),
      "Worker placement",
    );
  if (runtime.exports !== undefined && object(runtime.exports)) {
    for (const entry of Object.values(runtime.exports)) {
      knownKeys(entry, new Set(["type", "state", "cache"]), "Worker export");
      if (entry.cache !== undefined)
        knownKeys(entry.cache, new Set(["enabled"]), "Worker export cache");
    }
  }
}
function validateObservability(value) {
  if (value === undefined) return;
  knownKeys(
    value,
    new Set([
      "enabled",
      "head_sampling_rate",
      "issues",
      "logs",
      "redact_query_string",
      "traces",
    ]),
    "Worker observability",
  );
  if (value.issues !== undefined)
    knownKeys(
      value.issues,
      new Set(["enabled"]),
      "Worker observability issues",
    );
  if (value.logs !== undefined)
    knownKeys(
      value.logs,
      new Set([
        "enabled",
        "invocation_logs",
        "destinations",
        "head_sampling_rate",
        "persist",
      ]),
      "Worker observability logs",
    );
  if (value.traces !== undefined)
    knownKeys(
      value.traces,
      new Set([
        "enabled",
        "destinations",
        "head_sampling_rate",
        "persist",
        "propagation_policy",
      ]),
      "Worker observability traces",
    );
}
function normalizedRuntimeSettings(settings) {
  knownKeys(settings, SETTINGS_FIELDS, "Worker settings");
  validateRuntimeFields(settings);
  validateObservability(settings.observability);
  if (settings.exports_reconciliation !== undefined) {
    knownKeys(
      settings.exports_reconciliation,
      new Set([
        "created",
        "deleted",
        "info",
        "removable_entries",
        "renamed",
        "transfer_pending",
        "transferred",
        "updated",
        "warnings",
      ]),
      "Worker export reconciliation",
    );
    if (
      Object.values(settings.exports_reconciliation).some(
        (items) => !Array.isArray(items) || items.length !== 0,
      )
    ) {
      refuse("Worker export reconciliation is pending or ambiguous");
    }
  }
  return canonical(
    Object.fromEntries(
      Object.entries(settings)
        .filter(
          ([key]) => key !== "annotations" && key !== "exports_reconciliation",
        )
        .map(([key, value]) => [
          key,
          key === "bindings" ? normalizedBindings(value) : value,
        ]),
    ),
  );
}
function scriptSettings(settings) {
  knownKeys(settings, SCRIPT_SETTINGS_FIELDS, "Worker script settings");
  validateObservability(settings.observability);
  return canonical(settings);
}
function assertConfig(config, version, settings, scriptSetting) {
  if (!object(config)) refuse("realized Worker config is missing");
  const runtime = version.resources.script_runtime;
  for (const field of [
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "usage_model",
    "cache_options",
    "placement",
  ]) {
    if (config[field] === undefined) continue;
    const observed = runtime[field] ?? settings[field];
    const expected =
      field === "compatibility_date"
        ? normalizedDate(config[field])
        : config[field];
    const actual =
      field === "compatibility_date" ? normalizedDate(observed) : observed;
    if (!equal(expected, actual))
      refuse(`realized config ${field} differs from active Version`);
  }
  if (config.observability !== undefined) {
    for (const [key, value] of Object.entries(config.observability)) {
      if (!equal(scriptSetting.observability?.[key], value))
        refuse("realized config observability differs from active Worker");
    }
  }
  for (const field of [
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "usage_model",
    "cache_options",
    "placement",
  ]) {
    if (settings[field] === undefined) continue;
    const observed =
      field === "bindings" ? version.resources.bindings : runtime[field];
    if (observed === undefined) continue;
    if (field === "bindings") {
      if (
        !equal(
          normalizedBindings(settings[field]),
          normalizedBindings(observed),
        )
      )
        refuse("active settings bindings differ from Version");
    } else if (field === "compatibility_date") {
      if (normalizedDate(settings[field]) !== normalizedDate(observed))
        refuse(`active settings ${field} differs from Version`);
    } else if (!equal(settings[field], observed))
      refuse(`active settings ${field} differs from Version`);
  }
}
function parseDeployment(value) {
  if (
    !object(value) ||
    !UUID.test(value.id ?? "") ||
    value.strategy !== "percentage" ||
    !Array.isArray(value.versions) ||
    !value.versions.length ||
    value.versions.some(
      (part) =>
        !object(part) ||
        !UUID.test(part.version_id ?? "") ||
        typeof part.percentage !== "number" ||
        part.percentage <= 0 ||
        part.percentage > 100,
    ) ||
    Math.abs(
      value.versions.reduce((sum, part) => sum + part.percentage, 0) - 100,
    ) > 0.000001
  ) {
    refuse("active Deployment has malformed identity or traffic map");
  }
  return {
    deploymentId: value.id,
    trafficMap: value.versions.map((part) => ({
      versionId: part.version_id,
      percentage: part.percentage,
    })),
  };
}

export function createYurumeetCodeOnlyProvider({
  accountId,
  workerName,
  authentication,
  fetcher = globalThis.fetch,
}) {
  if (
    typeof accountId !== "string" ||
    !ACCOUNT.test(accountId) ||
    typeof workerName !== "string" ||
    !WORKER.test(workerName) ||
    workerName !== "yurumeet"
  ) {
    refuse("Cloudflare account or Yurumeet Worker target is invalid");
  }
  if (!object(authentication) || typeof fetcher !== "function")
    refuse("Cloudflare authentication or fetcher is unavailable");
  const headers = {};
  if (authentication.type === "api_token" || authentication.type === "oauth") {
    if (typeof authentication.token !== "string" || !authentication.token)
      refuse("Cloudflare token is unavailable");
    headers.Authorization = `Bearer ${authentication.token}`;
  } else if (authentication.type === "api_key") {
    if (
      typeof authentication.key !== "string" ||
      !authentication.key ||
      typeof authentication.email !== "string" ||
      !authentication.email
    ) {
      refuse("Cloudflare API key authentication is unavailable");
    }
    headers["X-Auth-Key"] = authentication.key;
    headers["X-Auth-Email"] = authentication.email;
  } else refuse("Cloudflare authentication type is unsupported");

  const base = `/accounts/${accountId}/workers/scripts/${workerName}`;
  const snapshots = new WeakMap();
  let phase = "PRE_UPLOAD_FAILURE";
  let uploadStarted = false;
  let promotionStarted = false;
  let acknowledgedVersionId;
  let acknowledgedDeploymentId;
  let uploadedSha256;
  let uploadedEtag;
  let uploadedSize;
  let recovery;
  let capturedDatabaseId;
  let initialSnapshot;
  const sensitive = new Set(
    authentication.type === "api_key"
      ? [authentication.key, authentication.email]
      : [authentication.token],
  );
  function registerSensitive(value) {
    if (typeof value === "string" && value) sensitive.add(value);
    else if (Array.isArray(value)) value.forEach(registerSensitive);
    else if (object(value)) Object.values(value).forEach(registerSensitive);
  }
  function sanitizedDiagnostic(payload) {
    const records = [
      ...(Array.isArray(payload?.errors) ? payload.errors : []),
      ...(Array.isArray(payload?.messages) ? payload.messages : []),
    ];
    const codes = records
      .map((record) => record?.code)
      .filter(Number.isInteger)
      .slice(0, 8);
    let diagnostic = records
      .map((record) =>
        typeof record?.message === "string" ? record.message : "",
      )
      .filter(Boolean)
      .slice(0, 4)
      .join(" | ");
    for (const secret of [...sensitive].sort((a, b) => b.length - a.length)) {
      diagnostic = diagnostic.replaceAll(secret, "[REDACTED]");
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret)
        diagnostic = diagnostic.replaceAll(escaped, "[REDACTED]");
    }
    return { codes, diagnostic: diagnostic.slice(0, 4096) };
  }
  const failure = (message, details = {}) =>
    new YurumeetProviderFailure(message, {
      phase,
      recovery: recovery
        ? {
            ...recovery,
            ...(acknowledgedVersionId
              ? { versionId: acknowledgedVersionId }
              : {}),
            ...(acknowledgedDeploymentId
              ? { publishedDeploymentId: acknowledgedDeploymentId }
              : {}),
          }
        : undefined,
      ...details,
    });
  async function request(path, { method = "GET", body } = {}) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          failure("Cloudflare request or response body timed out", {
            operation: `${method} ${path}`,
          }),
        );
      }, TIMEOUT_MS);
    });
    const work = async () => {
      let response;
      try {
        response = await fetcher(`${API}${path}`, {
          method,
          headers: {
            ...headers,
            ...(body instanceof FormData
              ? {}
              : body
                ? { "Content-Type": "application/json" }
                : {}),
          },
          body,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        throw failure("Cloudflare request failed", {
          operation: `${method} ${path}`,
        });
      }
      if (
        !response ||
        typeof response.status !== "number" ||
        response.redirected ||
        response.headers?.get("location") ||
        (response.status >= 300 && response.status < 400)
      ) {
        throw failure(
          "Cloudflare returned a non-success or redirect response",
          {
            operation: `${method} ${path}`,
            status: response?.status,
          },
        );
      }
      let bytes;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing body");
        const parts = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_BODY) {
            await reader.cancel();
            throw new Error("response too large");
          }
          parts.push(part.value);
        }
        bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
      } catch {
        throw failure(
          "Cloudflare response body was unavailable or exceeded the bound",
          { operation: `${method} ${path}` },
        );
      }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw failure("Cloudflare returned invalid JSON", {
          operation: `${method} ${path}`,
        });
      }
      if (
        !object(payload) ||
        response.status < 200 ||
        response.status >= 300 ||
        payload.success !== true ||
        payload.result === undefined
      ) {
        throw failure(
          "Cloudflare returned an unsuccessful or malformed API envelope",
          {
            operation: `${method} ${path}`,
            status: response.status,
            ...sanitizedDiagnostic(payload),
          },
        );
      }
      return payload.result;
    };
    try {
      return await Promise.race([work(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function verifyModuleContent(versionId, expectedSha256, expectedSize) {
    requireUuid(versionId, "Worker content Version id");
    const path = `${base}/content/v2?version=${versionId}`;
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          failure("Version content readback timed out", {
            operation: `GET ${path}`,
          }),
        );
      }, TIMEOUT_MS);
    });
    const work = async () => {
      let response;
      try {
        response = await fetcher(`${API}${path}`, {
          method: "GET",
          headers,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        throw failure("Version content readback failed", {
          operation: `GET ${path}`,
        });
      }
      if (
        !response ||
        response.status !== 200 ||
        response.redirected ||
        response.headers?.get("location")
      ) {
        throw failure(
          "Version content readback returned a non-success or redirect response",
          {
            operation: `GET ${path}`,
            status: response?.status,
          },
        );
      }
      const contentType = response.headers?.get("content-type");
      const boundaryMatch =
        typeof contentType === "string"
          ? /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s\r\n]+))$/i.exec(
              contentType,
            )
          : null;
      if (
        !boundaryMatch ||
        response.headers.get("cf-entrypoint") !== "worker.mjs"
      ) {
        throw failure(
          "Version content readback lacks the reviewed multipart entrypoint",
        );
      }
      const boundary = boundaryMatch[1] ?? boundaryMatch[2];
      if (boundary.length > 200)
        throw failure(
          "Version content multipart boundary exceeds the reviewed limit",
        );
      let bytes;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing body");
        const parts = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > expectedSize + CONTENT_OVERHEAD) {
            await reader.cancel();
            throw new Error("oversize");
          }
          parts.push(part.value);
        }
        bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
      } catch {
        throw failure(
          "Version content readback is unavailable or exceeds the reviewed size bound",
        );
      }
      const raw = Buffer.from(bytes);
      const opening = Buffer.from(`--${boundary}\r\n`);
      const headerEnd = raw.indexOf("\r\n\r\n", opening.length);
      if (
        !raw.subarray(0, opening.length).equals(opening) ||
        headerEnd < opening.length ||
        headerEnd - opening.length > 8192
      ) {
        throw failure("Version content multipart headers are malformed");
      }
      const partHeaders = raw
        .subarray(opening.length, headerEnd)
        .toString("utf8")
        .split("\r\n");
      if (
        partHeaders.length !== 2 ||
        !partHeaders.some((line) =>
          /^content-disposition: form-data; name="worker\.mjs"; filename="worker\.mjs"$/i.test(
            line,
          ),
        ) ||
        !partHeaders.some((line) =>
          /^content-type: application\/javascript\+module$/i.test(line),
        )
      ) {
        throw failure(
          "Version content main module has an unexpected media type or disposition",
        );
      }
      let form;
      try {
        form = await new Response(bytes, {
          headers: { "Content-Type": contentType },
        }).formData();
      } catch {
        throw failure("Version content readback is malformed multipart data");
      }
      const entries = [...form.entries()];
      if (
        entries.length !== 1 ||
        entries[0][0] !== "worker.mjs" ||
        !(entries[0][1] instanceof Blob) ||
        entries[0][1].name !== "worker.mjs"
      ) {
        throw failure(
          "Version content readback contains unexpected module parts",
        );
      }
      const moduleBytes = new Uint8Array(await entries[0][1].arrayBuffer());
      if (
        moduleBytes.byteLength !== expectedSize ||
        hash(moduleBytes) !== expectedSha256
      ) {
        throw failure(
          "Version content differs from the reviewed Worker bundle bytes",
        );
      }
      return { sha256: expectedSha256, size: expectedSize };
    };
    try {
      return await Promise.race([work(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function activeDeployment() {
    const result = await request(`${base}/deployments`);
    if (
      !object(result) ||
      !Array.isArray(result.deployments) ||
      result.deployments.length === 0
    ) {
      throw failure("Cloudflare returned no active Deployment");
    }
    return parseDeployment(result.deployments[0]);
  }
  async function readVersion(versionId) {
    requireUuid(versionId, "Worker Version id");
    const version = await request(`${base}/versions/${versionId}`);
    if (version?.id !== versionId)
      throw failure(
        "Worker Version readback identity differs from requested UUID",
      );
    versionClosure(version);
    return version;
  }
  async function readSettings() {
    const [settings, scriptSetting] = await Promise.all([
      request(`${base}/settings`),
      request(`${base}/script-settings`),
    ]);
    normalizedRuntimeSettings(settings);
    scriptSettings(scriptSetting);
    return { settings, scriptSetting };
  }
  function getSnapshot(snapshot) {
    const hidden = object(snapshot) ? snapshots.get(snapshot) : undefined;
    if (!hidden)
      throw failure(
        "provider snapshot is unavailable or belongs to another instance",
      );
    return hidden;
  }
  async function readTrafficAndVersion({
    requiredSecretNames,
    expectedConfig,
  } = {}) {
    if (initialSnapshot || uploadStarted)
      throw failure("initial traffic snapshot cannot be replaced");
    if (!object(expectedConfig))
      throw failure("realized Worker config is missing");
    const capturedConfig = structuredClone(expectedConfig);
    const capturedRequiredSecrets = Array.isArray(requiredSecretNames)
      ? [...requiredSecretNames]
      : requiredSecretNames;
    registerSensitive(expectedConfig?.vars);
    const deployment = await activeDeployment();
    recovery = {
      deploymentId: deployment.deploymentId,
      trafficMap: deployment.trafficMap,
      ...(deployment.trafficMap.length === 1
        ? { predecessorVersionId: deployment.trafficMap[0].versionId }
        : {}),
    };
    // Preserve the complete map for recovery. A split cannot choose a safe hidden Secret source.
    if (
      deployment.trafficMap.length !== 1 ||
      deployment.trafficMap[0].percentage !== 100
    ) {
      const activeVersions = await Promise.all(
        deployment.trafficMap.map((part) => readVersion(part.versionId)),
      );
      for (const activeVersion of activeVersions) {
        const parsedActive = versionClosure(activeVersion);
        validateBindings(
          parsedActive.bindings,
          capturedRequiredSecrets,
          capturedConfig,
          false,
        );
      }
      throw failure(
        "split traffic cannot select one exact Secret inheritance predecessor",
        {
          recovery: { ...deployment },
        },
      );
    }
    const predecessorVersionId = deployment.trafficMap[0].versionId;
    const [version, { settings, scriptSetting }] = await Promise.all([
      readVersion(predecessorVersionId),
      readSettings(),
    ]);
    const parsed = versionClosure(version);
    for (const binding of parsed.bindings.values()) {
      if (binding.type === "plain_text") registerSensitive(binding.text);
      if (binding.type === "json") registerSensitive(binding.json);
    }
    assertConfig(capturedConfig, version, settings, scriptSetting);
    const activeDatabaseId = validateBindings(
      parsed.bindings,
      capturedRequiredSecrets,
      capturedConfig,
    );
    const closureDigest = hash(Buffer.from(JSON.stringify(parsed.closure)));
    const snapshot = Object.freeze({
      deploymentId: deployment.deploymentId,
      trafficMap: Object.freeze(
        deployment.trafficMap.map((part) => Object.freeze(part)),
      ),
      predecessorVersionId,
      activeDatabaseId,
      closureDigest,
    });
    snapshots.set(snapshot, {
      deployment,
      version,
      parsed,
      settings,
      scriptSetting,
      expectedConfig: capturedConfig,
      requiredSecretNames: capturedRequiredSecrets,
      activeDatabaseId,
    });
    initialSnapshot = snapshot;
    capturedDatabaseId = snapshot.activeDatabaseId;
    recovery = {
      deploymentId: deployment.deploymentId,
      trafficMap: deployment.trafficMap,
      predecessorVersionId,
    };
    return snapshot;
  }
  async function revalidate(snapshot) {
    const hidden = getSnapshot(snapshot);
    const deployment = await activeDeployment();
    if (!equal(deployment, hidden.deployment))
      throw failure("active Deployment changed since predecessor capture");
    const [version, { settings, scriptSetting }] = await Promise.all([
      readVersion(snapshot.predecessorVersionId),
      readSettings(),
    ]);
    const parsed = versionClosure(version);
    assertConfig(hidden.expectedConfig, version, settings, scriptSetting);
    validateBindings(
      parsed.bindings,
      hidden.requiredSecretNames,
      hidden.expectedConfig,
    );
    if (
      parsed.etag !== hidden.parsed.etag ||
      !equal(parsed.closure, hidden.parsed.closure) ||
      !equal(
        normalizedRuntimeSettings(settings),
        normalizedRuntimeSettings(hidden.settings),
      ) ||
      !equal(
        scriptSettings(scriptSetting),
        scriptSettings(hidden.scriptSetting),
      )
    ) {
      throw failure(
        "predecessor Version or Worker settings changed since capture",
      );
    }
    return {
      deploymentId: deployment.deploymentId,
      trafficMap: deployment.trafficMap,
      predecessorVersionId: snapshot.predecessorVersionId,
      closureDigest: snapshot.closureDigest,
    };
  }
  async function queryReadonlySchema(
    databaseId,
    sql = MEDIA_DELETION_SCHEMA_QUERY,
  ) {
    if (uploadStarted)
      throw failure("schema query must complete before code upload");
    if (sql !== MEDIA_DELETION_SCHEMA_QUERY)
      throw failure("only the fixed read-only migration 0030 query is allowed");
    requireUuid(databaseId, "schema target D1 id");
    if (!recovery || capturedDatabaseId !== databaseId)
      throw failure("schema target must be the captured active Version DB");
    const result = await request(
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        body: JSON.stringify({ sql: MEDIA_DELETION_SCHEMA_QUERY }),
      },
    );
    return validateMediaDeletionQueryResults(result);
  }
  async function uploadCodeOnly({
    bundleBytes,
    snapshot,
    expectedConfig,
    message,
  } = {}) {
    if (uploadStarted)
      throw failure("a Worker Version upload was already attempted");
    const hidden = getSnapshot(snapshot);
    if (!equal(expectedConfig, hidden.expectedConfig))
      throw failure("realized config changed since predecessor capture");
    if (
      !(bundleBytes instanceof Uint8Array) ||
      bundleBytes.byteLength === 0 ||
      bundleBytes.byteLength > MAX_BUNDLE ||
      typeof message !== "string" ||
      !message ||
      message.length > 1000
    ) {
      throw failure("bundle or Version provenance message is invalid");
    }
    await revalidate(snapshot);
    const runtime = hidden.version.resources.script_runtime;
    const settings = hidden.settings;
    const metadata = {
      main_module: "worker.mjs",
      annotations: { "workers/message": message },
      bindings: [...hidden.parsed.bindings.keys()].sort().map((name) => ({
        name,
        type: "inherit",
        version_id: snapshot.predecessorVersionId,
      })),
    };
    for (const field of [
      "compatibility_date",
      "compatibility_flags",
      "limits",
      "usage_model",
      "cache_options",
      "placement",
    ]) {
      const value = runtime[field] ?? settings[field];
      if (value !== undefined)
        metadata[field] =
          field === "compatibility_date" ? normalizedDate(value) : value;
    }
    if (!metadata.compatibility_date)
      throw failure("active Version has no compatibility date to preserve");
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.append(
      "worker.mjs",
      new Blob([bundleBytes], { type: "application/javascript+module" }),
      "worker.mjs",
    );
    uploadStarted = true;
    phase = "POST_UPLOAD_INDETERMINATE";
    const result = await request(`${base}/versions?bindings_inherit=strict`, {
      method: "POST",
      body: form,
    });
    if (!object(result) || !UUID.test(result.id ?? ""))
      throw failure("Version upload acknowledgement omitted an exact UUID");
    acknowledgedVersionId = result.id;
    const uploaded = await readVersion(acknowledgedVersionId);
    const uploadedClosure = versionClosure(uploaded);
    if (!equal(uploadedClosure.closure, hidden.parsed.closure))
      throw failure("uploaded Version changed non-code closure");
    await verifyModuleContent(
      acknowledgedVersionId,
      hash(bundleBytes),
      bundleBytes.byteLength,
    );
    const { settings: afterSettings, scriptSetting: afterScriptSetting } =
      await readSettings();
    if (
      !equal(
        normalizedRuntimeSettings(afterSettings),
        normalizedRuntimeSettings(hidden.settings),
      ) ||
      !equal(
        scriptSettings(afterScriptSetting),
        scriptSettings(hidden.scriptSetting),
      )
    ) {
      throw failure("Worker settings changed after Version upload");
    }
    await revalidate(snapshot);
    uploadedSha256 = hash(bundleBytes);
    uploadedEtag = uploadedClosure.etag;
    uploadedSize = bundleBytes.byteLength;
    return { versionId: acknowledgedVersionId, sha256: uploadedSha256 };
  }
  async function promote({ snapshot, versionId, message } = {}) {
    if (
      !uploadStarted ||
      !uploadedSha256 ||
      promotionStarted ||
      versionId !== acknowledgedVersionId
    ) {
      throw failure(
        "Deployment promotion lacks the one verified uploaded Version",
      );
    }
    if (typeof message !== "string" || !message || message.length > 1000)
      throw failure("Deployment provenance message is invalid");
    await revalidate(snapshot);
    const candidateBeforePromotion = versionClosure(
      await readVersion(versionId),
    );
    if (
      candidateBeforePromotion.etag !== uploadedEtag ||
      !equal(
        candidateBeforePromotion.closure,
        getSnapshot(snapshot).parsed.closure,
      )
    ) {
      throw failure("uploaded Version changed before promotion");
    }
    await verifyModuleContent(versionId, uploadedSha256, uploadedSize);
    promotionStarted = true;
    phase = "POST_DEPLOY_INDETERMINATE";
    const result = await request(`${base}/deployments`, {
      method: "POST",
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": message },
      }),
    });
    const acknowledgement = parseDeployment(result);
    if (
      acknowledgement.trafficMap.length !== 1 ||
      acknowledgement.trafficMap[0].versionId !== versionId ||
      acknowledgement.trafficMap[0].percentage !== 100
    )
      throw failure("Deployment acknowledgement points to another Version");
    acknowledgedDeploymentId = acknowledgement.deploymentId;
    const [active, candidate, { settings, scriptSetting }] = await Promise.all([
      activeDeployment(),
      readVersion(versionId),
      readSettings(),
    ]);
    const hidden = getSnapshot(snapshot);
    const candidateClosure = versionClosure(candidate);
    if (
      !equal(active, acknowledgement) ||
      candidateClosure.etag !== uploadedEtag ||
      !equal(candidateClosure.closure, hidden.parsed.closure) ||
      !equal(
        normalizedRuntimeSettings(settings),
        normalizedRuntimeSettings(hidden.settings),
      ) ||
      !equal(
        scriptSettings(scriptSetting),
        scriptSettings(hidden.scriptSetting),
      )
    ) {
      throw failure(
        "promoted Worker readback differs from acknowledged code-only Deployment",
      );
    }
    return {
      deploymentId: acknowledgedDeploymentId,
      trafficMap: active.trafficMap,
      versionId,
      sha256: uploadedSha256,
    };
  }
  async function verifyPublished({ snapshot, versionId, deploymentId } = {}) {
    if (
      !promotionStarted ||
      !acknowledgedDeploymentId ||
      deploymentId !== acknowledgedDeploymentId ||
      versionId !== acknowledgedVersionId ||
      !uploadedSha256
    ) {
      throw failure(
        "published readback lacks the acknowledged Version and Deployment",
      );
    }
    const hidden = getSnapshot(snapshot);
    const [active, version, predecessorVersion, { settings, scriptSetting }] =
      await Promise.all([
        activeDeployment(),
        readVersion(versionId),
        readVersion(snapshot.predecessorVersionId),
        readSettings(),
      ]);
    const candidate = versionClosure(version);
    const predecessorReadback = versionClosure(predecessorVersion);
    if (
      active.deploymentId !== deploymentId ||
      active.trafficMap.length !== 1 ||
      active.trafficMap[0].versionId !== versionId ||
      active.trafficMap[0].percentage !== 100 ||
      candidate.etag !== uploadedEtag ||
      !equal(candidate.closure, hidden.parsed.closure) ||
      predecessorReadback.etag !== hidden.parsed.etag ||
      !equal(predecessorReadback.closure, hidden.parsed.closure) ||
      !equal(
        normalizedRuntimeSettings(settings),
        normalizedRuntimeSettings(hidden.settings),
      ) ||
      !equal(
        scriptSettings(scriptSetting),
        scriptSettings(hidden.scriptSetting),
      )
    ) {
      throw failure(
        "final published Worker no longer matches the acknowledged code-only result",
      );
    }
    await verifyModuleContent(versionId, uploadedSha256, uploadedSize);
    return {
      deploymentId,
      versionId,
      trafficMap: active.trafficMap,
      sha256: uploadedSha256,
    };
  }
  function guarded(method) {
    return async (...args) => {
      try {
        return await method(...args);
      } catch (error) {
        if (error instanceof YurumeetProviderFailure) {
          error.phase = phase;
          if (!error.recovery && recovery)
            error.recovery = failure("provider failed").recovery;
          throw error;
        }
        throw failure("provider returned an unrecognized failure");
      }
    };
  }
  return {
    readTrafficAndVersion: guarded(readTrafficAndVersion),
    revalidate: guarded(revalidate),
    queryReadonlySchema: guarded(queryReadonlySchema),
    uploadCodeOnly: guarded(uploadCodeOnly),
    promote: guarded(promote),
    verifyPublished: guarded(verifyPublished),
  };
}
