import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CANONICAL_ORIGIN_KV_KEY,
  PublicOriginError,
  resetObservedPublicOrigin,
  wrapRuntimeMessageBatch,
} from "@takosjp/yurucommu-core/server";

import { createEntrySource } from "./build-takos-worker.ts";

const entrySource = createEntrySource({});

const wranglerConfig = await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const moduleSource = await readFile(
  new URL("../main.tf", import.meta.url),
  "utf8",
);

describe("generated worker entry", () => {
  // The cron trigger fires whatever the deployed module exports. This entry
  // builds its own default object rather than re-exporting the core one, so a
  // missing scheduled() here means the retention sweep never runs anywhere.
  test("exports a scheduled handler that forwards to the core retention sweep", () => {
    expect(entrySource).toContain("async scheduled(");
    expect(entrySource).toContain("runYurucommuRetention");
    expect(entrySource).toContain(
      "await runYurucommuRetention(runtimeEnv as Env)",
    );
    // The handler used to be read off the core default export by name at call
    // time. That still ran, but it reached past the lane composition and could
    // only be checked once a cron had already fired.
    expect(entrySource).not.toContain("yurucommuCore");
    expect(entrySource).not.toContain("exposes no scheduled() retention");
  });

  // The origin every actor id, delivery signature, and `.well-known` document
  // is built from is ONE rule, and it belongs to the package that mints those
  // ids. This entry used to carry a second copy that set `APP_URL` from the
  // request origin on every request — which also meant the core's own rule saw
  // a configured `APP_URL` and never ran, so nothing was ever pinned and the
  // background path was left with no origin at all.
  test("owns no public-origin rule of its own", () => {
    expect(entrySource).not.toContain("withDefaultAppUrl");
    expect(entrySource).not.toContain("__yurucommu/runtime/canonical-origin");
    expect(entrySource).not.toContain("CANONICAL_ORIGIN_KV_KEY");
    expect(entrySource).not.toContain("withRequestAppUrl");
    expect(entrySource).not.toContain("function canonicalPublicOrigin");
  });

  // The request path calls nothing: `createYurucommuBackendApp` registers the
  // core's public-origin middleware ahead of every route, including /readyz and
  // the discovery documents. A call here would run after it and could only
  // disagree with it.
  test("delegates the request path to the core's middleware and the queue path to its background helper", () => {
    expect(entrySource).toContain("withRequiredBackgroundPublicOrigin");
    expect(entrySource).toContain(
      "await withRequiredBackgroundPublicOrigin(\n        wrapYurumeetWorkerBindings(env) as Env,\n      )",
    );
    expect(entrySource).not.toContain("establishRequestPublicOrigin");
    const fetchHandler = entrySource
      .slice(
        entrySource.indexOf("export default {"),
        entrySource.indexOf("  async queue("),
      )
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(fetchHandler).toContain("wrapYurumeetWorkerBindings(env)");
    expect(fetchHandler).not.toContain("APP_URL");
    // One await, and it is the app itself. Anything else here would be a second
    // origin rule running after the core's middleware had already decided.
    expect(fetchHandler.match(/await /g)).toHaveLength(1);
    expect(fetchHandler).toContain("await backendApp.fetch(");
  });

  test("requires both distinct direct queue names and exact invocation identity", () => {
    expect(entrySource).toContain("withDeliveryConsumerIdentity");
    expect(entrySource).toContain("Queue invocation has no native identity");
    expect(entrySource).toContain(
      "Delivery and DLQ queue identities must both be declared",
    );
    expect(entrySource).toContain(
      "Delivery and DLQ queue identities must be distinct",
    );
    expect(entrySource).toContain("Unrecognized queue identity: ");
    expect(entrySource).not.toContain("The Provider is free to replace");
    expect(entrySource).toContain("await withRequiredBackgroundPublicOrigin(");
  });

  // The lane names the BINDING SHAPE the host projects, and the entry has to
  // apply that one declaration to both halves of a queue event: the bindings
  // and the batch. Wrapping only the bindings would hand a facade batch
  // (acknowledgeAll) to code that calls ackAll.
  test("resolves the declared lane once and adapts both bindings and batch with it", () => {
    expect(entrySource).toContain("resolveYurumeetRuntimeLane");
    expect(entrySource).toContain(
      "const lane = resolveYurumeetRuntimeLane(env);",
    );
    expect(entrySource).toContain(
      "wrapRuntimeMessageBatch<DeliveryMessage>(batch, lane)",
    );
    expect(entrySource).toContain(
      "return handleYurucommuQueueBatch(queueBatch, runtimeEnv as Env)",
    );
    // fetch, queue, and scheduled all compose through the same call.
    expect(
      entrySource.match(/wrapYurumeetWorkerBindings\(env\)/g),
    ).toHaveLength(3);
    // The composition the entry no longer has: a raw cloudflare-only wrapper
    // that would hand `edge.sql` to drizzle-orm/d1 on a portable Host.
    expect(entrySource).not.toContain("wrapCloudflareBindings");
    expect(entrySource).not.toContain("takoform-v1");
  });

  test("uses only stable native event handlers in the Provider lane", () => {
    expect(entrySource).toContain("handleYurucommuQueueBatch");
    expect(entrySource).not.toContain(
      "handleTakosumiBackgroundEventInvocation",
    );
    expect(entrySource).not.toContain("background-events");
    expect(entrySource).not.toContain("TAKOSUMI_MANAGED_RUNTIME");
  });

  test("allows only the camera feature the Yurumeet document actually uses", () => {
    expect(entrySource).toContain(
      'import { withYurumeetDocumentPolicy } from "../src/runtime-policy.ts"',
    );
    expect(entrySource).toContain("withYurumeetDocumentPolicy(");
  });
});

describe("D1 migration ledger", () => {
  // Two ledgers over one non-idempotent migration set means the second runner
  // sees zero applied rows on an already-migrated database and replays 0001..
  // from the top, re-running table rebuilds against populated tables.
  // wrangler's default table is `d1_migrations`; the engine's own runners use
  // `yurucommu_migrations`, so wrangler has to be pointed at the same one.
  test("wrangler shares the engine's ledger table and migration set", () => {
    expect(wranglerConfig).toContain(
      '"migrations_table": "yurucommu_migrations"',
    );
    expect(wranglerConfig).toContain(
      '"migrations_dir": "node_modules/@takosjp/yurucommu-core/migrations"',
    );
  });
});

describe("retention cron surface", () => {
  test("wrangler config schedules the sweep", () => {
    expect(wranglerConfig).toContain('"crons"');
  });

  // The Capsule path has no wrangler.jsonc, so the trigger must also exist as a
  // resource or an OpenTofu install silently never sweeps.
  test("the Capsule module schedules the sweep", () => {
    expect(moduleSource).toContain(
      'resource "cloudflare_workers_cron_trigger" "retention"',
    );
  });
});

describe("owner-slot pin", () => {
  // OIDC-seeded installs force AUTH_PASSWORD_HASH empty, so the first sign-in
  // takes the single owner slot. The pin must be settable and the unpinned case
  // must require an explicit acknowledgement.
  test("projects the owner pin and the member allowlist as bindings", () => {
    expect(moduleSource).toContain('variable "oidc_owner_sub"');
    expect(moduleSource).toContain('variable "oidc_allowed_subs"');
    expect(moduleSource).toContain('name = "OIDC_OWNER_SUB"');
    expect(moduleSource).toContain('name = "OIDC_ALLOWED_SUBS"');
  });

  test("refuses an OIDC install with no pin unless the race is acknowledged", () => {
    expect(moduleSource).toContain("var.allow_unpinned_owner_claim");
  });

  test("does not generate a hidden bootstrap credential", () => {
    expect(moduleSource).not.toContain(
      'resource "random_id" "bootstrap_auth_token"',
    );
    expect(moduleSource).toContain(
      '!local.cloudflare_worker_enabled || local.provided_auth_password_hash != "" || local.has_takosumi_accounts_oidc',
    );
  });
});

// A queue event arrives in one of two shapes, and `withDeliveryConsumerIdentity`
// reads `batch.queue` off the WRAPPED batch. These prove that field survives
// both wrappers identically, which is what makes that read lane-independent.
describe("queue batch wrapping per lane", () => {
  function cloudflareBatch(queue: string, settled: string[]) {
    return {
      queue,
      messages: [
        {
          id: "m1",
          timestamp: new Date("2026-09-01T00:00:00.000Z"),
          attempts: 1,
          body: { type: "deliver_endpoint" },
          ack: () => settled.push("ack:m1"),
          retry: () => settled.push("retry:m1"),
        },
      ],
      ackAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  function facadeBatch(queue: string, settled: string[]) {
    return {
      batchId: "b1",
      queue,
      messages: [
        {
          id: "m1",
          timestampMillis: Date.parse("2026-09-01T00:00:00.000Z"),
          attempts: 1,
          // The facade carries bodies as bytes; the producer's JSON encoding is
          // what the consumer side undoes.
          body: {
            encoding: "base64",
            data: btoa(JSON.stringify({ type: "deliver_endpoint" })),
          },
          acknowledge: () => settled.push("ack:m1"),
          retry: () => settled.push("retry:m1"),
        },
      ],
      acknowledgeAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  test("carries the queue identity and settles through Cloudflare's batch", () => {
    const settled: string[] = [];
    const wrapped = wrapRuntimeMessageBatch(
      cloudflareBatch("yurumeet-delivery", settled) as never,
      "cloudflare",
    );
    expect(wrapped.queue).toBe("yurumeet-delivery");
    expect(wrapped.messages[0]?.body).toEqual({ type: "deliver_endpoint" });
    wrapped.ackAll();
    expect(settled).toEqual(["ackAll"]);
  });

  test("carries the same queue identity and settles through the facade batch", () => {
    const settled: string[] = [];
    const wrapped = wrapRuntimeMessageBatch(
      facadeBatch("yurumeet-delivery", settled) as never,
      "portable",
    );
    expect(wrapped.queue).toBe("yurumeet-delivery");
    expect(wrapped.messages[0]?.body).toEqual({ type: "deliver_endpoint" });
    wrapped.ackAll();
    expect(settled).toEqual(["ackAll"]);
  });

  test("refuses a batch whose shape contradicts the declared lane", () => {
    expect(() =>
      wrapRuntimeMessageBatch(cloudflareBatch("q", []) as never, "portable"),
    ).toThrow(/MessageBatch/);
    expect(() =>
      wrapRuntimeMessageBatch(facadeBatch("q", []) as never, "cloudflare"),
    ).toThrow(/acknowledgeAll/);
  });
});

describe("generated entry lane behavior", () => {
  const entryFile = new URL(
    "../dist/takos-entry.lane-test.ts",
    import.meta.url,
  );
  let entry: {
    default: {
      fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
      queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
      scheduled(controller: unknown, env: unknown, ctx: unknown): Promise<void>;
    };
  };

  afterAll(async () => {
    await rm(entryFile, { force: true });
  });

  async function loadEntry() {
    if (entry) return entry;
    await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
    await writeFile(entryFile, createEntrySource({}));
    entry = (await import(
      pathToFileURL(entryFile.pathname).href
    )) as typeof entry;
    return entry;
  }

  // Neither of these can be told apart from its counterpart by shape, which is
  // exactly why the lane is declared: `edge.kv` and a KV namespace expose the
  // same five methods.
  const kv = () => ({
    get: async () => null,
    getWithMetadata: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, listComplete: true }),
  });
  const nativeD1 = () => ({
    prepare: () => ({}),
    batch: async () => [],
    exec: async () => ({}),
  });
  const edgeSql = () => ({
    execute: async () => ({ rows: [], rowsWritten: 0 }),
    query: async () => ({ rows: [], rowsWritten: 0 }),
    transaction: async () => [],
  });

  function env(overrides: Record<string, unknown> = {}) {
    return {
      DB: nativeD1(),
      KV: kv(),
      APP_URL: "https://yurumeet.example.test",
      YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
      // Direct installs must declare both names; portable Hosts project the
      // same logical names with their lane's queue binding shape.
      DELIVERY_QUEUE_NAME: "configured-delivery",
      DELIVERY_DLQ_NAME: "configured-delivery-dlq",
      ...overrides,
    };
  }

  function cloudflareBatch(
    settled: string[],
    queue = "some-other-queue",
    body: unknown = {},
  ) {
    return {
      queue,
      messages: [
        {
          id: "m1",
          timestamp: new Date("2026-09-01T00:00:00.000Z"),
          attempts: 1,
          body,
          ack: () => settled.push("ack:m1"),
          retry: () => settled.push("retry:m1"),
        },
      ],
      ackAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  function facadeBatch(
    settled: string[],
    queue = "some-other-queue",
    body: unknown = {},
  ) {
    return {
      batchId: "b1",
      queue,
      messages: [
        {
          id: "m1",
          timestampMillis: Date.parse("2026-09-01T00:00:00.000Z"),
          attempts: 1,
          body: { encoding: "base64", data: btoa(JSON.stringify(body)) },
          acknowledge: () => settled.push("ack:m1"),
          retry: () => settled.push("retry:m1"),
        },
      ],
      acknowledgeAll: () => settled.push("ackAll"),
      retryAll: () => settled.push("retryAll"),
    };
  }

  test("generated fetch, queue, and scheduled entrypoints refuse a missing salt before binding effects on both lanes", async () => {
    const { default: worker } = await loadEntry();

    for (const lane of ["cloudflare", "portable"] as const) {
      const effects = {
        database: 0,
        kv: 0,
        objects: 0,
        queue: 0,
        batch: 0,
        context: 0,
      };
      const trackedKv = {
        get: async () => {
          effects.kv += 1;
          return null;
        },
        getWithMetadata: async () => {
          effects.kv += 1;
          return null;
        },
        put: async () => {
          effects.kv += 1;
        },
        delete: async () => {
          effects.kv += 1;
        },
        list: async () => {
          effects.kv += 1;
          return { keys: [], list_complete: true, listComplete: true };
        },
      };
      const nativeDatabase = {
        prepare: () => {
          effects.database += 1;
          return {
            bind: () => ({}),
            first: async () => null,
            all: async () => ({ results: [], success: true }),
            run: async () => ({ success: true }),
          };
        },
        batch: async () => {
          effects.database += 1;
          return [];
        },
        exec: async () => {
          effects.database += 1;
          return { count: 0, duration: 0 };
        },
      };
      const portableDatabase = {
        execute: async () => {
          effects.database += 1;
          return { rows: [], rowsWritten: 0 };
        },
        query: async () => {
          effects.database += 1;
          return { rows: [], rowsWritten: 0 };
        },
        transaction: async () => {
          effects.database += 1;
          return [];
        },
      };
      const nativeObjects = {
        head: async () => {
          effects.objects += 1;
          return null;
        },
        get: async () => {
          effects.objects += 1;
          return null;
        },
        put: async () => {
          effects.objects += 1;
          return {};
        },
        delete: async () => {
          effects.objects += 1;
        },
        list: async () => {
          effects.objects += 1;
          return { objects: [], truncated: false };
        },
        createMultipartUpload: async () => {
          effects.objects += 1;
          return {};
        },
        resumeMultipartUpload: () => {
          effects.objects += 1;
          return {};
        },
      };
      const portableObjects = {
        head: async () => {
          effects.objects += 1;
          return null;
        },
        get: async () => {
          effects.objects += 1;
          return null;
        },
        put: async () => {
          effects.objects += 1;
          return {};
        },
        delete: async () => {
          effects.objects += 1;
        },
        list: async () => {
          effects.objects += 1;
          return { objects: [], prefixes: [], truncated: false };
        },
      };
      const queueProducer = {
        send: async () => {
          effects.queue += 1;
        },
        sendBatch: async () => {
          effects.queue += 1;
        },
      };
      const bindings = {
        DB: lane === "cloudflare" ? nativeDatabase : portableDatabase,
        KV: trackedKv,
        MEDIA: lane === "cloudflare" ? nativeObjects : portableObjects,
        DELIVERY_QUEUE: queueProducer,
        DELIVERY_DLQ: queueProducer,
        DELIVERY_QUEUE_NAME: "configured-delivery",
        DELIVERY_DLQ_NAME: "configured-delivery-dlq",
        APP_URL: "https://yurumeet.example.test",
        YURUCOMMU_SESSION_HASH_SALT: undefined,
        ...(lane === "portable" ? { YURUCOMMU_RUNTIME_LANE: "portable" } : {}),
      };
      const batch =
        lane === "cloudflare"
          ? {
              queue: "configured-delivery",
              messages: [],
              ackAll: () => {
                effects.batch += 1;
              },
              retryAll: () => {
                effects.batch += 1;
              },
            }
          : {
              batchId: "salt-guard-test",
              queue: "configured-delivery",
              messages: [],
              acknowledgeAll: () => {
                effects.batch += 1;
              },
              retryAll: () => {
                effects.batch += 1;
              },
            };
      const context = {
        waitUntil: () => {
          effects.context += 1;
        },
      };
      const invocations = [
        [
          "fetch",
          () =>
            worker.fetch(
              new Request("https://yurumeet.example.test/readyz"),
              bindings,
              context,
            ),
        ],
        ["queue", () => worker.queue(batch, bindings, context)],
        [
          "scheduled",
          () =>
            worker.scheduled(
              { scheduledTime: 0, cron: "0 * * * *" },
              bindings,
              context,
            ),
        ],
      ] as const;

      for (const [name, invoke] of invocations) {
        let failure: unknown;
        try {
          await invoke();
        } catch (error) {
          failure = error;
        }
        expect(
          failure,
          `${lane} ${name} must refuse a missing session salt`,
        ).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(
          /YURUCOMMU_SESSION_HASH_SALT/,
        );
      }
      expect(effects).toEqual({
        database: 0,
        kv: 0,
        objects: 0,
        queue: 0,
        batch: 0,
        context: 0,
      });
    }
  });

  test("a Cloudflare event with an undeclared queue is refused without settling", async () => {
    const { default: worker } = await loadEntry();
    const settled: string[] = [];
    await expect(
      worker.queue(cloudflareBatch(settled), env(), {}),
    ).rejects.toThrow(/Unrecognized queue identity/);
    expect(settled).toEqual([]);
  });

  test("a portable event with an undeclared queue is refused without settling", async () => {
    const { default: worker } = await loadEntry();
    const settled: string[] = [];
    await expect(
      worker.queue(
        facadeBatch(settled),
        env({ YURUCOMMU_RUNTIME_LANE: "portable", DB: edgeSql() }),
        {},
      ),
    ).rejects.toThrow(/Unrecognized queue identity/);
    expect(settled).toEqual([]);
  });

  test("refuses a lane the build does not know rather than defaulting", async () => {
    const { default: worker } = await loadEntry();
    await expect(
      worker.queue(
        cloudflareBatch([]),
        env({ YURUCOMMU_RUNTIME_LANE: "takoform-v1" }),
        {},
      ),
    ).rejects.toThrow("YURUCOMMU_RUNTIME_LANE");
  });

  test("refuses a declaration the arriving bindings or batch contradict", async () => {
    const { default: worker } = await loadEntry();
    // Facade batch, undeclared lane.
    await expect(worker.queue(facadeBatch([]), env(), {})).rejects.toThrow(
      /acknowledgeAll/,
    );
    // Portable declared, raw D1 binding.
    await expect(
      worker.queue(
        facadeBatch([]),
        env({ YURUCOMMU_RUNTIME_LANE: "portable" }),
        {},
      ),
    ).rejects.toThrow(/D1Database/);
  });

  // The queue identity is read off the wrapped batch, so a host that invokes
  // the consumer without one fails closed on either lane rather than falling
  // back to a guessed delivery-queue name.
  test("both lanes refuse missing, partial, equal, and mismatched queue names", async () => {
    const { default: worker } = await loadEntry();
    const cases = [
      {
        label: "empty batch identity",
        queue: " ",
        overrides: {},
        error: /Queue invocation has no native identity/,
      },
      {
        label: "missing names",
        queue: "configured-delivery",
        overrides: {
          DELIVERY_QUEUE_NAME: undefined,
          DELIVERY_DLQ_NAME: undefined,
        },
        error: /identities must both be declared/,
      },
      {
        label: "missing DLQ name",
        queue: "configured-delivery",
        overrides: { DELIVERY_DLQ_NAME: undefined },
        error: /identities must both be declared/,
      },
      {
        label: "missing delivery name",
        queue: "configured-delivery-dlq",
        overrides: { DELIVERY_QUEUE_NAME: undefined },
        error: /identities must both be declared/,
      },
      {
        label: "equal names",
        queue: "same-queue",
        overrides: {
          DELIVERY_QUEUE_NAME: "same-queue",
          DELIVERY_DLQ_NAME: "same-queue",
        },
        error: /identities must be distinct/,
      },
      {
        label: "mismatched event name",
        queue: "unrecognized-queue",
        overrides: {},
        error: /Unrecognized queue identity/,
      },
    ];
    for (const lane of ["cloudflare", "portable"] as const) {
      for (const scenario of cases) {
        const settled: string[] = [];
        const batch =
          lane === "cloudflare"
            ? cloudflareBatch(settled, scenario.queue)
            : facadeBatch(settled, scenario.queue);
        const bindings =
          lane === "cloudflare"
            ? env(scenario.overrides)
            : env({
                ...scenario.overrides,
                YURUCOMMU_RUNTIME_LANE: "portable",
                DB: edgeSql(),
              });
        await expect(
          worker.queue(batch, bindings, {}),
          `${lane}: ${scenario.label}`,
        ).rejects.toThrow(scenario.error);
        expect(settled, `${lane}: ${scenario.label}`).toEqual([]);
      }
    }
  });

  async function captureQueueLogs(run: () => Promise<void>) {
    const lines: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    const capture = (...parts: unknown[]) => lines.push(parts.join(" "));
    console.warn = capture;
    console.error = capture;
    console.log = capture;
    try {
      await run();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      console.log = originalLog;
    }
    return lines.join("\n");
  }

  test("renamed native and portable queues reach the corresponding core handlers", async () => {
    const { default: worker } = await loadEntry();
    const cases = [
      {
        lane: "cloudflare" as const,
        queue: "native-main-renamed",
        bindingNames: {
          DELIVERY_QUEUE_NAME: "native-main-renamed",
          DELIVERY_DLQ_NAME: "native-dlq-renamed",
        },
        event: "delivery.queue.invalid_message",
      },
      {
        lane: "cloudflare" as const,
        queue: "native-dlq-renamed",
        bindingNames: {
          DELIVERY_QUEUE_NAME: "native-main-renamed",
          DELIVERY_DLQ_NAME: "native-dlq-renamed",
        },
        event: "delivery.dlq.invalid_message",
      },
      {
        lane: "portable" as const,
        queue: "portable-main-renamed",
        bindingNames: {
          DELIVERY_QUEUE_NAME: "portable-main-renamed",
          DELIVERY_DLQ_NAME: "portable-dlq-renamed",
        },
        event: "delivery.queue.invalid_message",
      },
      {
        lane: "portable" as const,
        queue: "portable-dlq-renamed",
        bindingNames: {
          DELIVERY_QUEUE_NAME: "portable-main-renamed",
          DELIVERY_DLQ_NAME: "portable-dlq-renamed",
        },
        event: "delivery.dlq.invalid_message",
      },
    ];

    for (const scenario of cases) {
      const settled: string[] = [];
      const batch =
        scenario.lane === "cloudflare"
          ? cloudflareBatch(settled, scenario.queue, { unrecognized: true })
          : facadeBatch(settled, scenario.queue, { unrecognized: true });
      const bindings =
        scenario.lane === "cloudflare"
          ? env(scenario.bindingNames)
          : env({
              ...scenario.bindingNames,
              YURUCOMMU_RUNTIME_LANE: "portable",
              DB: edgeSql(),
            });
      const logs = await captureQueueLogs(async () => {
        await worker.queue(batch, bindings, {});
      });
      expect(settled, scenario.queue).toEqual(["ack:m1"]);
      expect(logs, scenario.queue).toContain(scenario.event);
      expect(logs, scenario.queue).not.toContain("queue.unknown");
    }
  });
});

// What the entry does about the public origin, run rather than read. The
// generated module and this file resolve `@takosjp/yurucommu-core/server` to
// the same module instance, so the isolate-level observation the core caches is
// shared and has to be cleared between cases.
describe("public origin per lane", () => {
  const entryFile = new URL(
    "../dist/takos-entry.origin-test.ts",
    import.meta.url,
  );
  let entry: {
    default: {
      fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
      queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
    };
  };

  beforeEach(() => {
    resetObservedPublicOrigin();
  });

  afterAll(async () => {
    resetObservedPublicOrigin();
    await rm(entryFile, { force: true });
  });

  async function loadEntry() {
    if (entry) return entry;
    await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
    await writeFile(entryFile, createEntrySource({}));
    entry = (await import(
      pathToFileURL(entryFile.pathname).href
    )) as typeof entry;
    return entry;
  }

  // The `edge.kv` facade carries bytes, which is what makes an observed origin
  // a real round trip through the binding rather than a string handed back.
  function edgeKv() {
    const store = new Map<string, Uint8Array>();
    const writes: string[] = [];
    return {
      writes,
      read(key: string): string | undefined {
        const value = store.get(key);
        return value === undefined
          ? undefined
          : new TextDecoder().decode(value);
      },
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? null : { value };
      },
      // `edge.kv` is a byte store, but its `put` also accepts a string — and
      // that is the shape the core hands it. A fake that echoed the string back
      // from `get` would never exercise the decode the real binding forces.
      put: async (key: string, value: string | Uint8Array) => {
        writes.push(key);
        store.set(
          key,
          typeof value === "string" ? new TextEncoder().encode(value) : value,
        );
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], listComplete: true }),
    };
  }

  function nativeKv() {
    const store = new Map<string, string>();
    const writes: string[] = [];
    return {
      writes,
      read: (key: string) => store.get(key),
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => null,
      put: async (key: string, value: string) => {
        writes.push(key);
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true, listComplete: true }),
    };
  }

  const edgeSql = () => ({
    execute: async () => ({ rows: [], rowsWritten: 0 }),
    query: async () => ({ rows: [], rowsWritten: 0 }),
    transaction: async () => [],
  });
  const nativeD1 = () => ({
    prepare: () => ({}),
    batch: async () => [],
    exec: async () => ({}),
  });

  async function health(response: Response): Promise<string[]> {
    const body = (await response.json()) as { missingBindings: string[] };
    return body.missingBindings;
  }

  // The whole reason the rule exists: a Takoform `WorkerEndpoint` allocates the
  // public origin after the `WorkerVersion` that would have carried `APP_URL` is
  // already immutable, so the only place the origin is ever spoken is on the
  // requests the Host routes here.
  test("portable without APP_URL establishes the origin from the request and pins it", async () => {
    const { default: worker } = await loadEntry();
    const kv = edgeKv();
    const response = await worker.fetch(
      new Request("https://pinned.example.test/healthz"),
      {
        DB: edgeSql(),
        KV: kv,
        YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
        YURUCOMMU_RUNTIME_LANE: "portable",
      },
      {},
    );

    expect(await health(response)).not.toContain("APP_URL");
    expect(kv.writes).toEqual([CANONICAL_ORIGIN_KV_KEY]);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe(
      "https://pinned.example.test",
    );
  });

  // First writer wins, whatever `Host` a later request carries.
  test("portable keeps the pinned origin against a request from another host", async () => {
    const { default: worker } = await loadEntry();
    const kv = edgeKv();
    await kv.put(
      CANONICAL_ORIGIN_KV_KEY,
      new TextEncoder().encode("https://first.example.test"),
    );
    kv.writes.length = 0;

    await worker.fetch(
      new Request("https://second.example.test/healthz"),
      {
        DB: edgeSql(),
        KV: kv,
        YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
        YURUCOMMU_RUNTIME_LANE: "portable",
      },
      {},
    );

    expect(kv.writes).toEqual([]);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe("https://first.example.test");
  });

  // The lane wrangler deploys to. `APP_URL` is authoritative and nothing is
  // observed, cached, or written — this is exactly the previous behavior.
  test("cloudflare with APP_URL is untouched", async () => {
    const { default: worker } = await loadEntry();
    const kv = nativeKv();
    const bindings = {
      DB: nativeD1(),
      KV: kv,
      APP_URL: "https://configured.example.test",
      YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
    };

    expect(
      await health(
        await worker.fetch(
          new Request("https://workers-dev.example.test/healthz"),
          bindings,
          {},
        ),
      ),
    ).not.toContain("APP_URL");

    const discovery = (await (
      await worker.fetch(
        new Request("https://workers-dev.example.test/.well-known/yurucommu"),
        bindings,
        {},
      )
    ).json()) as { server: { canonicalOrigin: string } };
    expect(discovery.server.canonicalOrigin).toBe(
      "https://configured.example.test",
    );
    expect(kv.writes).toEqual([]);
  });

  // The old product-local `withDefaultAppUrl` shim set `APP_URL` from the
  // request on EVERY request, so the core's rule saw a configured origin, never
  // ran, and never wrote this key. That is what left the background path with
  // no origin at all.
  test("cloudflare without APP_URL establishes the origin from the request and pins it", async () => {
    const { default: worker } = await loadEntry();
    const kv = nativeKv();
    const response = await worker.fetch(
      new Request("https://workers-dev.example.test/healthz"),
      {
        DB: nativeD1(),
        KV: kv,
        YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
      },
      {},
    );

    expect(await health(response)).not.toContain("APP_URL");
    expect(kv.writes).toEqual([CANONICAL_ORIGIN_KV_KEY]);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe(
      "https://workers-dev.example.test",
    );
  });

  // Only an https request URL may name the instance. A proxy that terminates
  // TLS and speaks plain http to the Worker establishes nothing and must set
  // `APP_URL`; the readiness report says so instead of pinning "http://".
  test("cloudflare on plain http from a routable host establishes nothing and says so", async () => {
    const { default: worker } = await loadEntry();
    const kv = nativeKv();
    const response = await worker.fetch(
      new Request("http://workers-dev.example.test/healthz"),
      {
        DB: nativeD1(),
        KV: kv,
        YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
      },
      {},
    );

    expect(await health(response)).toContain("APP_URL");
    expect(kv.writes).toEqual([]);
  });

  function facadeBatch(queue: string) {
    return {
      batchId: "b1",
      queue,
      messages: [],
      acknowledgeAll: () => undefined,
      retryAll: () => undefined,
    };
  }

  // Delivery signs from this instance's own actor ids. Throwing retries the
  // batch after traffic has established an origin; the alternative is
  // `undefined/ap/users/...` cached by every peer it reached.
  test("queue with no origin at all fails closed", async () => {
    const { default: worker } = await loadEntry();
    await expect(
      worker.queue(
        facadeBatch("yurumeet-delivery"),
        {
          DB: edgeSql(),
          KV: edgeKv(),
          YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
          YURUCOMMU_RUNTIME_LANE: "portable",
        },
        {},
      ),
    ).rejects.toBeInstanceOf(PublicOriginError);
  });

  test("queue reads the origin a request already pinned", async () => {
    const { default: worker } = await loadEntry();
    const kv = edgeKv();
    const bindings = {
      DB: edgeSql(),
      KV: kv,
      YURUCOMMU_SESSION_HASH_SALT: "synthetic-test-session-salt",
      DELIVERY_QUEUE_NAME: "configured-main",
      DELIVERY_DLQ_NAME: "configured-dlq",
      YURUCOMMU_RUNTIME_LANE: "portable",
    };
    await worker.fetch(
      new Request("https://pinned.example.test/healthz"),
      bindings,
      {},
    );
    resetObservedPublicOrigin();

    // The background resolver reads the already-pinned origin before the
    // queue identity guard rejects this foreign event, so the failure must be
    // the identity error rather than PublicOriginError.
    await expect(
      worker.queue(facadeBatch("some-other-queue"), bindings, {}),
    ).rejects.toThrow(/Unrecognized queue identity/);
    expect(kv.read(CANONICAL_ORIGIN_KV_KEY)).toBe(
      "https://pinned.example.test",
    );
  });
});
