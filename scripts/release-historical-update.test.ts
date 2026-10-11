import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the product's private JavaScript validation surface within the four
// fixture files; a separate generated declaration is unnecessary here.
const modulePath: string = "./release-historical-update.mjs";
const {
  canonicalProjectionSqlValue,
  validateHistoricalLedgerRows,
  validatePushDefinitions,
  verifyPinnedFixtureFile,
} = await import(modulePath);
const issuerModulePath: string = "./release-storage-oidc.mjs";
const { createSyntheticRestoreIssuer } = await import(issuerModulePath);

const pins = JSON.parse(
  readFileSync(
    new URL("./historical-v012-fixture.json", import.meta.url),
    "utf8",
  ),
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function nativeRows(): { id: number; name: string; applied_at: string }[] {
  return pins.migrations.map((migration: { name: string }, index: number) => ({
    id: index + 1,
    name: migration.name,
    applied_at: "2026-10-11 15:11:38",
  }));
}

describe("published predecessor admission", () => {
  test("requires every physical Wrangler row in exact native order", () => {
    const valid = nativeRows();
    expect(validateHistoricalLedgerRows(valid)).toEqual(
      pins.wranglerNativeBaseline.names,
    );
    for (const invalid of [
      valid.slice(0, -1),
      [
        ...valid,
        { id: 20, name: "0020_unknown.sql", applied_at: "2026-10-11 15:11:38" },
      ],
      valid.map((row, index) =>
        index === 18 ? { ...row, name: "0019_third_shape.sql" } : row,
      ),
      valid.map((row, index) => (index === 1 ? { ...row, id: 21 } : row)),
      valid.map((row, index) =>
        index === 0 ? { ...row, applied_at: "invented" } : row,
      ),
      [valid[1], valid[0], ...valid.slice(2)],
    ])
      expect(() => validateHistoricalLedgerRows(invalid)).toThrow();
  });

  test("rejects a same-name 0019 declaration change or extra push trigger", () => {
    const sql = "CREATE TABLE notification_pushers (id TEXT PRIMARY KEY)";
    const shapePins = {
      wranglerNativeBaseline: {
        pushSchemaDefinitions: [
          {
            type: "table",
            name: "notification_pushers",
            tblName: "notification_pushers",
            sha256: createHash("sha256").update(sql).digest("hex"),
          },
        ],
      },
    };
    const accepted = [
      {
        type: "table",
        name: "notification_pushers",
        tbl_name: "notification_pushers",
        sql,
      },
    ];
    expect(() => validatePushDefinitions(accepted, shapePins)).not.toThrow();
    expect(() =>
      validatePushDefinitions(
        [
          {
            ...accepted[0],
            sql: `${sql} REFERENCES actors(ap_id) ON DELETE CASCADE`,
          },
        ],
        shapePins,
      ),
    ).toThrow();
    expect(() =>
      validatePushDefinitions(
        [
          ...accepted,
          {
            type: "trigger",
            name: "custom_notification_push_trigger",
            tbl_name: "notification_pushers",
            sql: "CREATE TRIGGER custom_notification_push_trigger AFTER INSERT ON notification_pushers BEGIN SELECT 1; END",
          },
        ],
        shapePins,
      ),
    ).toThrow();
  });

  test("refuses changed bytes and a truncated historical SQL input", () => {
    const directory = mkdtempSync(join(tmpdir(), "yurumeet-old-sql-pin-test-"));
    directories.push(directory);
    const path = join(directory, "0019.sql");
    const original = Buffer.from("published SQL\n");
    const hash = createHash("sha256").update(original).digest("hex");
    writeFileSync(path, original);
    expect(verifyPinnedFixtureFile(path, hash, original.length)).toEqual(
      original,
    );
    writeFileSync(path, Buffer.from("changed__SQL\n"));
    expect(() =>
      verifyPinnedFixtureFile(path, hash, original.length),
    ).toThrow();
    writeFileSync(path, original.subarray(0, 3));
    expect(() =>
      verifyPinnedFixtureFile(path, hash, original.length),
    ).toThrow();
  });
});

describe("complete historical row projection", () => {
  test("retains D1 BLOB bytes, including empty and offset views", () => {
    expect(canonicalProjectionSqlValue([0, 255, 1])).toEqual(["blob", "AP8B"]);
    expect(canonicalProjectionSqlValue([])).toEqual(["blob", ""]);
    expect(canonicalProjectionSqlValue(new Uint8Array(0).buffer)).toEqual([
      "blob",
      "",
    ]);
    const backing = new Uint8Array([9, 0, 255, 8]);
    expect(canonicalProjectionSqlValue(backing.subarray(1, 3))).toEqual([
      "blob",
      "AP8=",
    ]);
  });

  test("keeps text, number, integer, boolean, and BLOB types distinct", () => {
    expect(canonicalProjectionSqlValue("1")).toEqual(["text", "1"]);
    expect(canonicalProjectionSqlValue(1)).toEqual(["number", "1"]);
    expect(canonicalProjectionSqlValue(1.25)).toEqual(["number", "1.25"]);
    expect(canonicalProjectionSqlValue(-0)).toEqual(["number", "-0"]);
    expect(canonicalProjectionSqlValue(1n)).toEqual(["integer", "1"]);
    expect(canonicalProjectionSqlValue(true)).toEqual(["boolean", true]);
    expect(canonicalProjectionSqlValue("AP8B")).toEqual(["text", "AP8B"]);
    expect(canonicalProjectionSqlValue([0, 255, 1])).toEqual(["blob", "AP8B"]);
  });

  test("refuses lossy or unsupported native row values without printing values", () => {
    const sparse: number[] = new Array<number>(2);
    sparse[0] = 1;
    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
    ]) {
      expect(() => canonicalProjectionSqlValue(value)).toThrow(
        "historical update row-unsafe-integer",
      );
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => canonicalProjectionSqlValue(value)).toThrow(
        "historical update row-nonfinite-number",
      );
    }
    for (const value of [
      undefined,
      {},
      new Date(0),
      [-1],
      [256],
      [1.5],
      ["1"],
      [NaN],
      [{}],
      sparse,
    ]) {
      expect(() => canonicalProjectionSqlValue(value)).toThrow(
        "historical update row-value-supported",
      );
    }
  });
});

describe("synthetic historical OIDC issuer admission", () => {
  test("retains the current restore owner-pin default and permits the old namespaced pin", async () => {
    const origin = "https://historical-update.yurumeet.invalid";
    const need = (condition: boolean, label: string) => {
      if (!condition) throw new Error(label);
    };
    const current = await createSyntheticRestoreIssuer({ origin, need });
    expect(current.bindings).toEqual({
      OIDC_ISSUER_URL: "https://restore-issuer.yurumeet.invalid",
      OIDC_CLIENT_ID: "native-restore-synthetic-public-client",
      OIDC_OWNER_SUB: "restore_fixture",
    });
    const historical = await createSyntheticRestoreIssuer({
      origin,
      need,
      subject: "historical_owner",
      ownerPin: "takos:historical_owner",
    });
    expect(historical.bindings.OIDC_OWNER_SUB).toBe("takos:historical_owner");
    const foreign = await historical.fetch(
      new Request("https://real-issuer.example/oauth/jwks"),
    );
    const unsupported = await historical.fetch(
      new Request("https://restore-issuer.yurumeet.invalid/oauth/authorize"),
    );
    expect(foreign.status).toBe(502);
    expect(unsupported.status).toBe(502);
    expect(historical.evidence()).toMatchObject({
      blocked: 2,
      token: 0,
      userinfo: 0,
    });
  });
});
