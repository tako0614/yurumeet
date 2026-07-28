import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

import { createEntrySource } from "./build-takos-worker.ts";
import {
  PRODUCT_CATALOG_KEY,
  PRODUCT_CLIENT_KEY,
  PRODUCT_WIRE_IDENTITY,
} from "../src/product-identity.ts";

const rootDir = new URL("../", import.meta.url);

async function collectSourceFiles(dir: URL): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      dir,
    );
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(child)));
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

const sourceFiles = [
  ...(await collectSourceFiles(new URL("src/", rootDir))),
  ...(await collectSourceFiles(new URL("scripts/", rootDir))),
];

describe("product wire identity", () => {
  // The token names the family engine (@takosjp/yurucommu-core), which is what
  // mobile clients compare against before they make any other call. It shipped
  // as "yurumeet" once and every mobile connection to a deployed Yurumeet
  // failed with `Host is yurumeet, not yurucommu.`
  test("advertises the yurucommu family engine token", () => {
    expect(PRODUCT_WIRE_IDENTITY.product).toBe("yurucommu");
  });

  test("keeps the per-app keys in their own namespaces", () => {
    expect(PRODUCT_CLIENT_KEY).toBe("yurume");
    expect(PRODUCT_CATALOG_KEY).toBe("yurumeet");
    expect(PRODUCT_WIRE_IDENTITY.clients.map((client) => client.id)).toContain(
      PRODUCT_CLIENT_KEY,
    );
  });

  test("the built Worker bakes in exactly this document", () => {
    const entrySource = createEntrySource({});
    expect(entrySource).toContain(
      JSON.stringify(PRODUCT_WIRE_IDENTITY, null, 2),
    );
    expect(entrySource).toContain('"product": "yurucommu"');
  });
});

describe("wire identity has one home", () => {
  // A wire value spelled out in two files is a value that will disagree, and
  // the disagreement that already happened (mock server vs. built Worker) was
  // invisible because development only ever exercised one of the two copies.
  // Any producer that needs the token must import it.
  const declarationPattern = /\bproduct:\s*"(yurucommu|yurumeet)"/g;

  test("no source file re-declares a discovery product token", async () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.pathname.endsWith("/src/product-identity.ts")) continue;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(declarationPattern)) {
        offenders.push(
          `${file.pathname.slice(rootDir.pathname.length)}: ${match[0]}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("D1 migration ledger", () => {
  // Two ledgers over one non-idempotent migration set means the second runner
  // replays 0001.. against a populated database. wrangler's default table is
  // `d1_migrations`; the engine's runners use `yurucommu_migrations`.
  test("wrangler shares the engine's ledger table", async () => {
    const wranglerConfig = await readFile(
      new URL("wrangler.jsonc", rootDir),
      "utf8",
    );
    expect(wranglerConfig).toContain(
      '"migrations_table": "yurucommu_migrations"',
    );
  });
});
