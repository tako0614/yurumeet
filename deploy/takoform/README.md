# Yurumeet Takoform Capsule

This directory is the canonical managed-resource definition for Yurumeet. It
uses current Takoform resources directly and does not point a Cloudflare
provider at a Takosumi compatibility endpoint.

The root OpenTofu module remains the supported direct-Cloudflare deployment
path. Both modules deploy the same product, but they have different
authorities:

- `main.tf` at the repository root owns a direct Cloudflare installation.
- `deploy/takoform/` declares the portable resource graph consumed by a
  Takoform host.
- Takosumi owns install lifecycle, target selection, credentials, secrets,
  migrations, public URLs, and rollback.

The Capsule intentionally asks for queue `consume` and `publish` permissions
and a `Schedule -> EdgeWorker` trigger. A host must reject the installation
until it can materialize those requirements. It must not silently downgrade
them.

The graph also owns its opaque `yurumeet.launcher@1` Interface document. The
provider has no UI-specific resource: it stores app-authored JSON and asks the
host to resolve the public `HttpService` origin. Runtime discovery and access
remain host-governed.

## Schema authority

`migrations/schema-bundle.json` is this module's migration authority. It is
generated, never hand-edited:

```bash
bun run generate:schema-bundle
```

The generator reads the SQL out of the installed `@takosjp/yurucommu-core`
package only after proving that `package.json`, `bun.lock`, and
`node_modules` all name the same version and that the lock carries an
integrity hash for it. The provenance is therefore pinned to the lock rather
than to whatever happens to be on disk, and each entry records the SHA-256 of
its exact bytes.

The direct-Cloudflare lane needs none of this: `wrangler.jsonc` points
`migrations_dir` straight into the core package and shares the
`yurucommu_migrations` ledger. A Takoform host has no such package, so the SQL
has to travel as module input.

### The one Takoform override

`migrations/takoform-overrides/0003_activity_remote_object_edges.sql` replaces
the core file of the same name. The core version disables foreign keys at the
connection level, which D1 ignores, and a Takoform host applies each migration
file atomically with them enabled — so replacing `activities` would
cascade-delete every `inbox` row. The override rebuilds the sole referencing
table first under `PRAGMA defer_foreign_keys`.

The override declares the digest of the core file it replaces. A core release
that edits that migration fails the generator instead of silently keeping a
rewrite of an older file.

## Source preparation

The selected repository revision is the source of truth for both the module
and its Worker bytes:

```bash
bun run build:takos-worker
bun run prepare:takoform-v1
```

The second command hashes the current worktree's `dist/takos-worker.js`,
copies the exact bytes to `.generated/yurumeet-worker.js`, verifies the copied
digest, and rewrites `migrations/sql/` from the digest-verified
`migrations/schema-bundle.json`, checking each file back after writing it.

It refuses an artifact carrying a **static** `node:` import. A portable host
resolves those when the module graph is instantiated, so such a bundle fails
before a single line of the Worker runs. The core reaches its DNS builtin
through `await import("node:dns/promises")` on the path that needs it, which
stays allowed.

The SQL files are tracked module inputs, so OpenTofu never depends on a host
copying build output before it can construct the migration set.
`.generated/yurumeet-worker.js` is intentionally untracked source-build output.

## Provider validation

```bash
bun scripts/validate-takoform-v1.ts
```

The module is copied to a temporary directory, where the pinned Provider is
initialized and the copy validated. The ephemeral lock, CLI configuration,
data directory, and plugin files are removed with that copy and are never
written into this directory — which is why this module, unlike the root one,
has no checked-in `.terraform.lock.hcl`.

Validation writes its own `TF_CLI_CONFIG_FILE` containing only a `direct {}`
installation method. It does not inherit `TF_CLI_CONFIG_FILE`, the legacy
`TERRAFORM_CONFIG`, `HOME/.tofurc`, or XDG development overrides, and it drops
inherited `TF_CLI_ARGS*`, plugin-cache, reattach, and plugin TLS variables, so
a caller cannot redirect where the Provider comes from.

To validate an unpublished local Provider candidate instead, supply both the
executable and its digest as explicit authority:

```bash
export TAKOFORM_PROVIDER_BINARY=/absolute/path/to/terraform-provider-takoform
export TAKOFORM_PROVIDER_SHA256=sha256:<64-lowercase-hex-digest>
bun scripts/validate-takoform-v1.ts
```

Both values are required together: a half-configured environment fails rather
than quietly falling back to the registry.

## What this module still owes

The graph itself has not been rewritten yet. `main.tf` pins
`registry.opentofu.org/tako0614/takoform = 0.2.0`, whose entire resource
vocabulary was **withdrawn** by Takoform spec decision 0042 — the provider is
still downloadable, so `tofu validate` passes, but no current host implements
those resources. Until that rewrite lands:

- the module still fetches the Worker from a pinned release URL, so the
  prepared `.generated/yurumeet-worker.js` is not yet the bytes it deploys;
- nothing in the module reads `migrations/sql/`, so an install still comes up
  against an empty database;
- `bun run check:opentofu` is defined but not chained into `bun run check`,
  because gating on a dead vocabulary only locks it in place.

Do not make this module selectable in the public Store until that rewrite
lands and the selected host proves:

1. Worker runtime config and secret injection.
2. Queue producer and consumer registration, including the DLQ consumer.
3. Hourly scheduled invocation of the Worker.
4. Migrations, a stable public URL, accounts OIDC, push configuration,
   destroy, and rollback.

## Focused checks

```bash
bun test scripts/schema-bundle.test.ts \
  scripts/prepare-takoform-v1-source.test.ts \
  scripts/validate-takoform-v1.test.ts \
  scripts/takoform-capsule.test.ts
tofu fmt -check -recursive
```
