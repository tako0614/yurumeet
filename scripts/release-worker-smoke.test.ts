import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, stop } from "esbuild";

import { createEntrySource } from "./build-takos-worker.ts";
import { PRODUCT_WIRE_IDENTITY } from "../src/product-identity.ts";

const repo = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const fixtureOrigin = "https://release-smoke.yurumeet.invalid";
const smokeHtml =
  '<!doctype html><html><head><title>Yurumeet</title></head><body><div id="root"></div></body></html>';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function entrySource() {
  return createEntrySource({
    "index.html": {
      contentType: "text/html; charset=utf-8",
      body: Buffer.from(smokeHtml).toString("base64"),
    },
  });
}

async function generatedArtifact(directory: string, source = entrySource()) {
  const artifactPath = join(directory, "yurumeet-worker.js");
  try {
    await build({
      stdin: {
        contents: source,
        resolveDir: join(repo, "scripts"),
        sourcefile: "takos-entry.generated.ts",
        loader: "ts",
      },
      outfile: artifactPath,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
    });
  } finally {
    stop();
  }
  return artifactPath;
}

async function smoke(artifactPath: string) {
  const bytes = await Bun.file(artifactPath).bytes();
  const digest = createHash("sha256").update(bytes).digest("hex");
  return Bun.spawnSync(
    [
      "bun",
      "scripts/smoke-release-worker.mjs",
      artifactPath,
      `sha256:${digest}`,
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
}

function httpHealthyArtifact() {
  return `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const native = typeof env.DB?.prepare === "function" && typeof env.KV?.get === "function" && typeof env.MEDIA?.put === "function";
    if (url.pathname === "/readyz") return Response.json({ status: native ? "ok" : "misconfigured", service: "yurucommu", missingBindings: native ? [] : ["DB", "KV", "MEDIA"] }, { status: native ? 200 : 503 });
    if (url.pathname === "/.well-known/yurucommu") return Response.json({ ...${JSON.stringify({ product: PRODUCT_WIRE_IDENTITY.product, name: PRODUCT_WIRE_IDENTITY.name, clients: PRODUCT_WIRE_IDENTITY.clients })}, server: { id: ${JSON.stringify(PRODUCT_WIRE_IDENTITY.serverId)}, name: ${JSON.stringify(PRODUCT_WIRE_IDENTITY.serverName)}, canonicalOrigin: env.APP_URL } });
    return new Response(${JSON.stringify(smokeHtml)}, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
`;
}

async function writeHttpHealthyArtifact(directory: string) {
  const artifactPath = join(directory, "yurumeet-worker.js");
  await writeFile(artifactPath, httpHealthyArtifact());
  return artifactPath;
}

async function expectSmokeToRejectFakeWrite(handler: string, expected: string) {
  const fetchAnchor = "    const bindings = wrapYurumeetWorkerBindings(env);";
  const source = entrySource();
  expect(source).toContain(fetchAnchor);
  const artifactSource = source.replace(
    fetchAnchor,
    `${handler}${fetchAnchor}`,
  );
  const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
  temporaryDirectories.push(directory);
  const artifactPath = await generatedArtifact(directory, artifactSource);
  const result = await smoke(artifactPath);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(expected);
}

describe("release Worker smoke", () => {
  test("boots the generated entry and verifies native queue and scheduled effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = await generatedArtifact(directory);
    const result = await smoke(artifactPath);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      kind: "yurumeet.release-worker-smoke@v1",
      artifact: "yurumeet-worker.js",
      runtime: "workerd",
      substrate: "runtime-native-bindings",
      checks: [
        "readyz",
        "discovery",
        "embedded-ui",
        "main-queue-fanout",
        "dlq-exhaustion",
        "scheduled-story-retention",
        "scheduled-story-retention-idempotence",
        "authenticated-dm",
        "dm-isolation",
        "media-upload",
        "media-readback",
        "private-media-read-refusal",
        "invalid-media-refusal",
        "unauthenticated-api-refusal",
      ],
      migrationCount: expect.any(Number),
      status: "PASSED",
    });
  }, 30_000);

  test("rejects a fake successful DM response without persistence", async () => {
    await expectSmokeToRejectFakeWrite(
      `    const journeyUrl = new URL(request.url);
    if (request.method === "POST" && journeyUrl.pathname.startsWith("/api/dm/user/")) {
      return Response.json({
        message: { id: "${fixtureOrigin}/ap/objects/fake-dm", content: "release smoke direct message", created_at: new Date().toISOString() },
        conversation_id: "${fixtureOrigin}/ap/conversations/fake-dm",
      }, { status: 201 });
    }
`,
      "DM object was not persisted",
    );
  }, 30_000);

  test("rejects a fake successful media response without persistence", async () => {
    await expectSmokeToRejectFakeWrite(
      `    const journeyUrl = new URL(request.url);
    if (request.method === "POST" && journeyUrl.pathname === "/api/media/upload") {
      return Response.json({ url: "/media/abcdef.png", r2_key: "uploads/abcdef.png", content_type: "image/png", id: "abcdef" });
    }
`,
      "media upload was not persisted",
    );
  }, 60_000);

  test("rejects a DM read by an unrelated session", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/dm/user/") && request.headers.get("cookie") === "session=release-smoke-session-unrelated-ecf49f83") {
      const headers = new Headers(request.headers);
      headers.set("cookie", "session=release-smoke-session-recipient-a108328f");
      request = new Request(request, { headers });
    }\n`,
      "DM isolation exposed a message to an unrelated actor",
    );
  }, 30_000);

  test("rejects an HTTP-healthy artifact without background handlers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = await writeHttpHealthyArtifact(directory);

    const result = await smoke(artifactPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("main-queue-fanout");
  }, 30_000);

  test("rejects no-op main queue, DLQ, and scheduled handlers", async () => {
    const noOpMutations = [
      {
        label: "main queue",
        find: "    const lane = resolveYurumeetRuntimeLane(env);",
        replacement:
          '    if (batch.queue === "yurumeet-delivery") { for (const message of batch.messages) message.ack(); return; }\n    const lane = resolveYurumeetRuntimeLane(env);',
        expected: "main-queue-fanout",
      },
      {
        label: "DLQ",
        find: "    const lane = resolveYurumeetRuntimeLane(env);",
        replacement:
          '    if (batch.queue === "yurumeet-delivery-dlq") { for (const message of batch.messages) message.ack(); return; }\n    const lane = resolveYurumeetRuntimeLane(env);',
        expected: "dlq-exhaustion",
      },
      {
        label: "scheduled",
        find: "    await runRetention(runtimeEnv);",
        replacement: "    void runtimeEnv;",
        expected: "expired Story/media state",
      },
    ];

    for (const mutation of noOpMutations) {
      const source = entrySource();
      expect(source, `${mutation.label} mutation anchor`).toContain(
        mutation.find,
      );
      const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
      temporaryDirectories.push(directory);
      const artifactPath = await generatedArtifact(
        directory,
        source.replace(mutation.find, mutation.replacement),
      );
      const result = await smoke(artifactPath);
      expect(result.exitCode, mutation.label).not.toBe(0);
      expect(result.stdout.toString(), mutation.label).toBe("");
      expect(result.stderr.toString(), mutation.label).toContain(
        mutation.expected,
      );
    }
  }, 60_000);

  test("rejects a queue handler that retries the main message", async () => {
    const source = entrySource();
    const anchor = "    const lane = resolveYurumeetRuntimeLane(env);";
    expect(source).toContain(anchor);
    const retrying = source.replace(
      anchor,
      '    if (batch.queue === "yurumeet-delivery") { batch.messages[0]?.retry(); return; }\n    const lane = resolveYurumeetRuntimeLane(env);',
    );
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = await generatedArtifact(directory, retrying);
    const result = await smoke(artifactPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("main-queue-fanout");
  }, 30_000);

  test("rejects bytes that do not match the release digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "yurumeet-worker.js");
    await writeFile(
      artifactPath,
      'export default { fetch() { return new Response("changed"); } };\n',
    );

    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/smoke-release-worker.mjs",
        artifactPath,
        `sha256:${"0".repeat(64)}`,
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("does not equal sha256:");
  });
});
