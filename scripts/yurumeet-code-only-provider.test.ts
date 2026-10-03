import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createYurumeetCodeOnlyProvider,
  YurumeetProviderFailure,
} from "./yurumeet-code-only-provider.mjs";
import { MEDIA_DELETION_SCHEMA_QUERY } from "./check-media-deletion-schema.mjs";

const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dbId = "00000000-0000-4000-8000-000000000001";
const otherDbId = "00000000-0000-4000-8000-000000000002";
const predecessor = "00000000-0000-4000-8000-000000000010";
const staged = "00000000-0000-4000-8000-000000000011";
const candidate = "00000000-0000-4000-8000-000000000012";
const oldDeployment = "00000000-0000-4000-8000-000000000020";
const newDeployment = "00000000-0000-4000-8000-000000000021";
const bundle = new TextEncoder().encode(
  "export default {fetch(){return new Response('new')}};",
);
const sha = createHash("sha256").update(bundle).digest("hex");
const API = "https://api.cloudflare.com/client/v4";
const base = `/accounts/${accountId}/workers/scripts/yurumeet`;
const requiredSecretNames = [
  "YURUCOMMU_SESSION_HASH_SALT",
  "ENCRYPTION_KEY",
  "AUTH_PASSWORD_HASH",
];
const bindings: (Record<string, unknown> & { name: string; type: string })[] = [
  { name: "DB", type: "d1", database_id: dbId },
  { name: "KV", type: "kv_namespace", namespace_id: "b".repeat(32) },
  { name: "MEDIA", type: "r2_bucket", bucket_name: "yurumeet-media" },
  { name: "DELIVERY_QUEUE", type: "queue", queue_name: "yurumeet-delivery" },
  { name: "DELIVERY_DLQ", type: "queue", queue_name: "yurumeet-delivery-dlq" },
  { name: "YURUCOMMU_SESSION_HASH_SALT", type: "secret_text" },
  { name: "ENCRYPTION_KEY", type: "secret_text" },
  { name: "AUTH_PASSWORD_HASH", type: "secret_text" },
  {
    name: "DELIVERY_QUEUE_NAME",
    type: "plain_text",
    text: "yurumeet-delivery",
  },
];
const runtime = {
  compatibility_date: "2026-07-16T00:00:00Z",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  exports: { default: { type: "worker", state: "created" } },
};
const config = {
  compatibility_date: "2026-07-16",
  compatibility_flags: runtime.compatibility_flags,
  observability: { enabled: true },
  d1_databases: [
    { binding: "DB", database_name: "yurumeet-db", database_id: dbId },
  ],
  kv_namespaces: [{ binding: "KV", id: "b".repeat(32) }],
  r2_buckets: [{ binding: "MEDIA", bucket_name: "yurumeet-media" }],
  queues: {
    producers: [
      { binding: "DELIVERY_QUEUE", queue: "yurumeet-delivery" },
      { binding: "DELIVERY_DLQ", queue: "yurumeet-delivery-dlq" },
    ],
  },
  vars: { DELIVERY_QUEUE_NAME: "yurumeet-delivery" },
};
const settings = {
  bindings,
  compatibility_date: runtime.compatibility_date,
  compatibility_flags: runtime.compatibility_flags,
  observability: { enabled: true },
};
const scriptSettings = {
  observability: { enabled: true },
  logpush: false,
  tags: [],
  tail_consumers: [],
};
const schemaRows = [
  {
    kind: "column",
    ordinal: 0,
    name: "r2_key",
    detail: "TEXT",
    required: 1,
    position: 1,
  },
  {
    kind: "column",
    ordinal: 1,
    name: "uploader_ap_id",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    kind: "column",
    ordinal: 2,
    name: "created_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    kind: "column",
    ordinal: 3,
    name: "next_attempt_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    kind: "index",
    ordinal: 0,
    name: "media_blob_deletion_jobs_due_idx",
    detail: "c",
    required: 0,
    position: 0,
  },
  {
    kind: "index-column",
    ordinal: 0,
    name: "next_attempt_at",
    detail: "",
    required: 0,
    position: 3,
  },
  {
    kind: "index-column",
    ordinal: 1,
    name: "created_at",
    detail: "",
    required: 0,
    position: 2,
  },
  {
    kind: "index-column",
    ordinal: 2,
    name: "r2_key",
    detail: "",
    required: 0,
    position: 0,
  },
];
const version = (
  id: string,
  etag = "a".repeat(64),
  actualBindings = bindings,
) => ({
  id,
  number: id === predecessor ? 4 : 5,
  resources: {
    bindings: actualBindings,
    script: { etag },
    script_runtime: runtime,
  },
});
const envelope = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function fixture(
  options: {
    split?: boolean;
    mutateCandidate?: (
      value: ReturnType<typeof version>,
    ) => ReturnType<typeof version>;
    mutatePredecessor?: (
      value: ReturnType<typeof version>,
    ) => ReturnType<typeof version>;
    failUpload?: "reject" | "malformed" | "denied";
    failDeploy?: "reject" | "malformed";
    leak?: string;
    driftAfterPromote?: boolean;
    contentVariant?:
      | "wrong-bytes"
      | "missing-entrypoint"
      | "extra-part"
      | "wrong-mime"
      | "oversize"
      | "redirect";
    etagDrift?: boolean;
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let active = false;
  let promotedReads = 0;
  let candidateReads = 0;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(API, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body });
    if (method === "GET" && path === `${base}/deployments`) {
      if (active) promotedReads += 1;
      return envelope({
        deployments: [
          {
            id: active ? newDeployment : oldDeployment,
            strategy: "percentage",
            versions: active
              ? [
                  {
                    version_id:
                      options.driftAfterPromote && promotedReads > 1
                        ? staged
                        : candidate,
                    percentage: 100,
                  },
                ]
              : options.split
                ? [
                    { version_id: predecessor, percentage: 50 },
                    { version_id: staged, percentage: 50 },
                  ]
                : [{ version_id: predecessor, percentage: 100 }],
          },
        ],
      });
    }
    if (method === "GET" && path === `${base}/versions/${predecessor}`) {
      return envelope(
        options.mutatePredecessor?.(version(predecessor)) ??
          version(predecessor),
      );
    }
    if (method === "GET" && path === `${base}/versions/${staged}`) {
      return envelope(version(staged, "c".repeat(64)));
    }
    if (method === "GET" && path === `${base}/versions/${candidate}`) {
      candidateReads += 1;
      const candidateVersion = version(
        candidate,
        options.etagDrift && candidateReads > 1
          ? "opaque-provider-etag-changed"
          : "opaque-provider-etag",
      );
      return envelope(
        options.mutateCandidate?.(candidateVersion) ?? candidateVersion,
      );
    }
    if (
      method === "GET" &&
      path === `${base}/content/v2?version=${candidate}`
    ) {
      if (options.contentVariant === "redirect") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.invalid" },
        });
      }
      const content =
        options.contentVariant === "wrong-bytes"
          ? new TextEncoder().encode("old version bytes")
          : options.contentVariant === "oversize"
            ? new Uint8Array(bundle.byteLength + 65_536)
            : bundle;
      const form = new FormData();
      form.append(
        "worker.mjs",
        new Blob([content], {
          type:
            options.contentVariant === "wrong-mime"
              ? "application/octet-stream"
              : "application/javascript+module",
        }),
        "worker.mjs",
      );
      if (options.contentVariant === "extra-part") {
        form.append(
          "unexpected.mjs",
          new Blob(["extra"], { type: "application/javascript+module" }),
          "unexpected.mjs",
        );
      }
      const response = new Response(form);
      if (options.contentVariant !== "missing-entrypoint")
        response.headers.set("cf-entrypoint", "worker.mjs");
      return response;
    }
    if (method === "GET" && path === `${base}/settings`)
      return envelope(settings);
    if (method === "GET" && path === `${base}/script-settings`)
      return envelope(scriptSettings);
    if (
      method === "POST" &&
      path === `/accounts/${accountId}/d1/database/${dbId}/query`
    ) {
      return envelope([
        { success: true, meta: { duration: 1 }, results: schemaRows },
      ]);
    }
    if (
      method === "POST" &&
      path === `${base}/versions?bindings_inherit=strict`
    ) {
      if (options.failUpload === "reject")
        throw new Error(`token ${options.leak}`);
      if (options.failUpload === "malformed")
        return new Response(`{ "secret": "${options.leak}"`, { status: 200 });
      if (options.failUpload === "denied")
        return new Response(
          JSON.stringify({
            success: false,
            errors: [
              {
                code: 10001,
                message: `denied ${options.leak} ${JSON.stringify(options.leak).slice(1, -1)} yurumeet-delivery`,
              },
            ],
          }),
          { status: 403 },
        );
      return envelope({ id: candidate });
    }
    if (method === "POST" && path === `${base}/deployments`) {
      if (options.failDeploy === "reject") {
        active = true;
        throw new Error(`secret ${options.leak}`);
      }
      if (options.failDeploy === "malformed") {
        active = true;
        return new Response("not-json", { status: 200 });
      }
      active = true;
      return envelope({
        id: newDeployment,
        strategy: "percentage",
        versions: [{ version_id: candidate, percentage: 100 }],
      });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  const provider = createYurumeetCodeOnlyProvider({
    accountId,
    workerName: "yurumeet",
    authentication: {
      type: "api_token",
      token: options.leak ?? "credential-private",
    },
    fetcher,
  });
  return { provider, calls };
}

describe("Yurumeet code-only Cloudflare publisher", () => {
  test("inherits every active binding from the exact serving UUID and verifies built bytes, settings, and active D1", async () => {
    const { provider, calls } = fixture();
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    expect(snapshot.activeDatabaseId).toBe(dbId);
    expect(snapshot.trafficMap).toEqual([
      { versionId: predecessor, percentage: 100 },
    ]);
    await expect(
      provider.queryReadonlySchema(otherDbId, MEDIA_DELETION_SCHEMA_QUERY),
    ).rejects.toThrow();
    const schema = await provider.queryReadonlySchema(
      dbId,
      MEDIA_DELETION_SCHEMA_QUERY,
    );
    expect(schema).toMatchObject({ scope: "migration-0030-only" });
    const d1 = calls.find((call) => call.path.includes("/d1/database/"));
    expect(d1?.path).toBe(`/accounts/${accountId}/d1/database/${dbId}/query`);
    expect(JSON.parse(d1?.body as string)).toEqual({
      sql: MEDIA_DELETION_SCHEMA_QUERY,
    });
    const uploaded = await provider.uploadCodeOnly({
      bundleBytes: bundle,
      snapshot,
      expectedConfig: config,
      message: "commit:0123456789 artifact:sha256",
    });
    expect(uploaded).toEqual({ versionId: candidate, sha256: sha });
    expect(
      calls.filter(
        (call) => call.path === `${base}/content/v2?version=${candidate}`,
      ),
    ).toHaveLength(1);
    const upload = calls.find((call) =>
      call.path.endsWith("/versions?bindings_inherit=strict"),
    );
    expect(upload?.method).toBe("POST");
    const form = upload?.body as FormData;
    const metadata = JSON.parse(form.get("metadata") as string);
    expect(metadata.bindings).toEqual(
      bindings
        .map((binding) => binding.name)
        .sort()
        .map((name) => ({ name, type: "inherit", version_id: predecessor })),
    );
    expect(metadata).not.toHaveProperty("keep_bindings");
    expect(metadata).not.toHaveProperty("assets");
    expect(metadata.compatibility_date).toBe("2026-07-16");
    expect(
      new Uint8Array(await (form.get("worker.mjs") as Blob).arrayBuffer()),
    ).toEqual(bundle);
    expect(
      calls.some((call) => call.path === `${base}/versions/${staged}`),
    ).toBe(false);
    const promoted = await provider.promote({
      snapshot,
      versionId: candidate,
      message: "commit:0123456789",
    });
    expect(promoted.deploymentId).toBe(newDeployment);
    expect(
      await provider.verifyPublished({
        snapshot,
        versionId: candidate,
        deploymentId: newDeployment,
      }),
    ).toMatchObject({ versionId: candidate, sha256: sha });
    expect(
      calls.filter(
        (call) => call.path === `${base}/content/v2?version=${candidate}`,
      ),
    ).toHaveLength(3);
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.path)).toEqual([
      `/accounts/${accountId}/d1/database/${dbId}/query`,
      `${base}/versions?bindings_inherit=strict`,
      `${base}/deployments`,
    ]);
    expect(JSON.parse(writes[2]?.body as string)).toEqual({
      strategy: "percentage",
      versions: [{ version_id: candidate, percentage: 100 }],
      annotations: { "workers/message": "commit:0123456789" },
    });
  });

  test("refuses split traffic and a drifted configured DB before any write", async () => {
    const split = fixture({ split: true });
    await expect(
      split.provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: config,
      }),
    ).rejects.toMatchObject({
      phase: "PRE_UPLOAD_FAILURE",
      recovery: {
        trafficMap: [
          { versionId: predecessor, percentage: 50 },
          { versionId: staged, percentage: 50 },
        ],
      },
    });
    expect(split.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    const drifted = fixture();
    await expect(
      drifted.provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: {
          ...config,
          d1_databases: [{ ...config.d1_databases[0], database_id: otherDbId }],
        },
      }),
    ).rejects.toThrow(/config DB differs/);
    expect(drifted.calls.filter((call) => call.method !== "GET")).toHaveLength(
      0,
    );

    const jurisdiction = fixture();
    await expect(
      jurisdiction.provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: {
          ...config,
          r2_buckets: [{ ...config.r2_buckets[0], jurisdiction: "eu" }],
        },
      }),
    ).rejects.toThrow(/R2 jurisdiction differs/);
    expect(
      jurisdiction.calls.filter((call) => call.method !== "GET"),
    ).toHaveLength(0);
  });

  test("rejects missing required Secret, unknown Version field, mutated config, and arbitrary SQL", async () => {
    const missingSecret = fixture();
    await expect(
      missingSecret.provider.readTrafficAndVersion({
        requiredSecretNames: [...requiredSecretNames, "MISSING_SECRET"],
        expectedConfig: config,
      }),
    ).rejects.toThrow(/required binding/);
    expect(
      missingSecret.calls.filter((call) => call.method !== "GET"),
    ).toHaveLength(0);

    const futureField = fixture({
      mutatePredecessor: (value) =>
        ({ ...value, future_resource_change: { enabled: true } }) as ReturnType<
          typeof version
        >,
    });
    await expect(
      futureField.provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: config,
      }),
    ).rejects.toThrow(/unreviewed field/);
    expect(
      futureField.calls.filter((call) => call.method !== "GET"),
    ).toHaveLength(0);

    const { provider, calls } = fixture();
    const suppliedConfig = structuredClone(config);
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: suppliedConfig,
    });
    await expect(
      provider.queryReadonlySchema(dbId, "DELETE FROM users"),
    ).rejects.toThrow(/fixed read-only/);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    suppliedConfig.d1_databases[0].database_id = otherDbId;
    await expect(
      provider.uploadCodeOnly({
        bundleBytes: bundle,
        snapshot,
        expectedConfig: suppliedConfig,
        message: "reviewed",
      }),
    ).rejects.toThrow(/config changed/);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("rejects changed candidate bindings and malformed opaque etag after one upload", async () => {
    for (const mutateCandidate of [
      (value: ReturnType<typeof version>) => ({
        ...value,
        resources: {
          ...value.resources,
          bindings: value.resources.bindings.map((binding) =>
            binding.name === "DB"
              ? { ...binding, database_id: otherDbId }
              : binding,
          ),
        },
      }),
      (value: ReturnType<typeof version>) => ({
        ...value,
        resources: { ...value.resources, script: { etag: "" } },
      }),
    ]) {
      const { provider, calls } = fixture({ mutateCandidate });
      const snapshot = await provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: config,
      });
      await expect(
        provider.uploadCodeOnly({
          bundleBytes: bundle,
          snapshot,
          expectedConfig: config,
          message: "reviewed",
        }),
      ).rejects.toMatchObject({ phase: "POST_UPLOAD_INDETERMINATE" });
      await expect(
        provider.promote({
          snapshot,
          versionId: candidate,
          message: "reviewed",
        }),
      ).rejects.toThrow(/lacks the one verified/);
      expect(
        calls.filter(
          (call) => call.method === "POST" && call.path.includes("/versions?"),
        ),
      ).toHaveLength(1);
      expect(
        calls.filter(
          (call) =>
            call.method === "POST" && call.path.endsWith("/deployments"),
        ),
      ).toHaveLength(0);
    }
  });

  test("accepts the same inherited binding set when Cloudflare changes array order", async () => {
    const { provider } = fixture({
      mutateCandidate: (value) => ({
        ...value,
        resources: {
          ...value.resources,
          bindings: [...value.resources.bindings].reverse(),
        },
      }),
    });
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    const uploaded = await provider.uploadCodeOnly({
      bundleBytes: bundle,
      snapshot,
      expectedConfig: config,
      message: "reviewed",
    });
    const promoted = await provider.promote({
      snapshot,
      versionId: uploaded.versionId,
      message: "reviewed",
    });
    expect(
      await provider.verifyPublished({
        snapshot,
        versionId: uploaded.versionId,
        deploymentId: promoted.deploymentId,
      }),
    ).toMatchObject({ sha256: sha });
  });

  test("accepts an equivalent named binding map without discarding field values", async () => {
    const { provider } = fixture({
      mutateCandidate: (value) => ({
        ...value,
        resources: {
          ...value.resources,
          bindings: Object.fromEntries(
            value.resources.bindings.map(({ name, ...rest }) => [name, rest]),
          ) as unknown as typeof value.resources.bindings,
        },
      }),
    });
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    const uploaded = await provider.uploadCodeOnly({
      bundleBytes: bundle,
      snapshot,
      expectedConfig: config,
      message: "reviewed",
    });
    expect(uploaded.sha256).toBe(sha);
  });

  test("rejects wrong Version content, malformed multipart and redirect before promotion", async () => {
    for (const contentVariant of [
      "wrong-bytes",
      "missing-entrypoint",
      "extra-part",
      "wrong-mime",
      "oversize",
      "redirect",
    ] as const) {
      const { provider, calls } = fixture({ contentVariant });
      const snapshot = await provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: config,
      });
      await expect(
        provider.uploadCodeOnly({
          bundleBytes: bundle,
          snapshot,
          expectedConfig: config,
          message: "reviewed",
        }),
      ).rejects.toMatchObject({ phase: "POST_UPLOAD_INDETERMINATE" });
      await expect(
        provider.promote({
          snapshot,
          versionId: candidate,
          message: "reviewed",
        }),
      ).rejects.toThrow(/lacks the one verified/);
      expect(
        calls.filter(
          (call) =>
            call.method === "POST" && call.path.endsWith("/deployments"),
        ),
      ).toHaveLength(0);
    }
  });

  test("treats provider etag as opaque and blocks a changed candidate before Deployment POST", async () => {
    const { provider, calls } = fixture({ etagDrift: true });
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    const uploaded = await provider.uploadCodeOnly({
      bundleBytes: bundle,
      snapshot,
      expectedConfig: config,
      message: "reviewed",
    });
    expect(uploaded.sha256).toBe(sha);
    await expect(
      provider.promote({
        snapshot,
        versionId: uploaded.versionId,
        message: "reviewed",
      }),
    ).rejects.toMatchObject({ phase: "POST_UPLOAD_INDETERMINATE" });
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/deployments"),
      ),
    ).toHaveLength(0);
  });

  test("does not retry lost acknowledgements and never emits credentials or provider bodies", async () => {
    const leak = "credential-private-secret-value";
    for (const failUpload of ["reject", "malformed", "denied"] as const) {
      const { provider, calls } = fixture({ failUpload, leak });
      const snapshot = await provider.readTrafficAndVersion({
        requiredSecretNames,
        expectedConfig: config,
      });
      let failure: unknown;
      try {
        await provider.uploadCodeOnly({
          bundleBytes: bundle,
          snapshot,
          expectedConfig: config,
          message: "reviewed",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(YurumeetProviderFailure);
      expect((failure as YurumeetProviderFailure).phase).toBe(
        "POST_UPLOAD_INDETERMINATE",
      );
      expect(JSON.stringify(failure)).not.toContain(leak);
      expect((failure as Error).message).not.toContain(leak);
      if (failUpload === "denied") {
        expect((failure as YurumeetProviderFailure).codes).toEqual([10001]);
        expect((failure as YurumeetProviderFailure).diagnostic).toContain(
          "[REDACTED]",
        );
        expect((failure as YurumeetProviderFailure).diagnostic).not.toContain(
          "yurumeet-delivery",
        );
      }
      expect(
        calls.filter(
          (call) => call.method === "POST" && call.path.includes("/versions?"),
        ),
      ).toHaveLength(1);
      await expect(
        provider.uploadCodeOnly({
          bundleBytes: bundle,
          snapshot,
          expectedConfig: config,
          message: "reviewed",
        }),
      ).rejects.toThrow(/already attempted/);
      expect(
        calls.filter(
          (call) => call.method === "POST" && call.path.includes("/versions?"),
        ),
      ).toHaveLength(1);
    }
  });

  test("redacts raw and JSON-escaped credential forms in a structured provider denial", async () => {
    const leak = 'token-"quoted\\value';
    const { provider } = fixture({ failUpload: "denied", leak });
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    let failure: unknown;
    try {
      await provider.uploadCodeOnly({
        bundleBytes: bundle,
        snapshot,
        expectedConfig: config,
        message: "reviewed",
      });
    } catch (error) {
      failure = error;
    }
    const diagnostic = (failure as YurumeetProviderFailure).diagnostic ?? "";
    expect(diagnostic).not.toContain(leak);
    expect(diagnostic).not.toContain(JSON.stringify(leak).slice(1, -1));
    expect(diagnostic).toContain("[REDACTED]");
    expect(diagnostic.length).toBeLessThanOrEqual(4096);
  });

  test("does not retry an indeterminate Deployment and retains exact predecessor recovery", async () => {
    const leak = 'escaped\\"credential-private';
    const { provider, calls } = fixture({ failDeploy: "reject", leak });
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    const uploaded = await provider.uploadCodeOnly({
      bundleBytes: bundle,
      snapshot,
      expectedConfig: config,
      message: "reviewed",
    });
    let failure: unknown;
    try {
      await provider.promote({
        snapshot,
        versionId: uploaded.versionId,
        message: "reviewed",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(YurumeetProviderFailure);
    expect((failure as YurumeetProviderFailure).phase).toBe(
      "POST_DEPLOY_INDETERMINATE",
    );
    expect((failure as YurumeetProviderFailure).recovery).toMatchObject({
      deploymentId: oldDeployment,
      predecessorVersionId: predecessor,
      versionId: candidate,
    });
    expect(JSON.stringify(failure)).not.toContain(leak);
    await expect(
      provider.promote({
        snapshot,
        versionId: uploaded.versionId,
        message: "reviewed",
      }),
    ).rejects.toThrow(/lacks the one verified/);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/deployments"),
      ),
    ).toHaveLength(1);
  });

  test("blocks a PUBLISHED claim if active traffic changes after initial post-promotion readback", async () => {
    const { provider, calls } = fixture({ driftAfterPromote: true });
    const snapshot = await provider.readTrafficAndVersion({
      requiredSecretNames,
      expectedConfig: config,
    });
    const uploaded = await provider.uploadCodeOnly({
      bundleBytes: bundle,
      snapshot,
      expectedConfig: config,
      message: "reviewed",
    });
    const promoted = await provider.promote({
      snapshot,
      versionId: uploaded.versionId,
      message: "reviewed",
    });
    await expect(
      provider.verifyPublished({
        snapshot,
        versionId: uploaded.versionId,
        deploymentId: promoted.deploymentId,
      }),
    ).rejects.toMatchObject({ phase: "POST_DEPLOY_INDETERMINATE" });
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/deployments"),
      ),
    ).toHaveLength(1);
  });
});
