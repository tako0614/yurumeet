import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  coreMigrationsDir,
  shouldInstallDependenciesBeforeRelease,
} from "./takosumi-release";

test("release migrations include notification push delivery from core", () => {
  const migrationsDir = coreMigrationsDir();
  expect(migrationsDir).toContain(
    join("node_modules", "@takosjp", "yurucommu-core", "migrations"),
  );
  expect(
    existsSync(join(migrationsDir, "0019_notification_push_delivery.sql")),
  ).toBe(true);
});

test("migrations-only release materializes dependencies when needed", () => {
  expect(
    shouldInstallDependenciesBeforeRelease({
      migrationsOnly: true,
      coreMigrationsAvailable: false,
    }),
  ).toBe(true);
  expect(
    shouldInstallDependenciesBeforeRelease({
      migrationsOnly: true,
      coreMigrationsAvailable: true,
    }),
  ).toBe(false);
  expect(
    shouldInstallDependenciesBeforeRelease({
      migrationsOnly: false,
      coreMigrationsAvailable: true,
    }),
  ).toBe(true);
});
