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
  public URLs, and rollback.

## The graph

One `ModuleWorker` with its own bytes, schema, storage, and triggers:

| Resource                                         | Why the module owns it                                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| `takoform_module_worker`                         | The Worker identity every other resource attaches to.   |
| `takoform_worker_bundle` / `_version`            | The exact bytes and the bindings they run with.         |
| `takoform_worker_deployment` / `_endpoint`       | Serves that version and allocates the public URL.       |
| `takoform_sqlite_database`                       | `DB`.                                                   |
| `takoform_sqlite_migration_set` / `_application` | The schema, applied before any version serves.          |
| `takoform_edge_kv_namespace`                     | `KV`.                                                   |
| `takoform_edge_object_bucket`                    | `MEDIA`, owned rather than requested as an external S3. |
| `takoform_at_least_once_queue` ×2                | `DELIVERY_QUEUE` and its dead-letter queue.             |
| `takoform_queue_consumer` ×2                     | Drains both — see below.                                |
| `takoform_worker_cron_trigger`                   | The hourly retention sweep.                             |

The `WorkerVersion` depends on the migration application, so a Host cannot
serve a version against a database whose schema has not been applied, and the
`ModuleWorker` depends on every backing Form, so none of them can be destroyed
while the Worker still exists.

Both queues get a consumer. The dead-letter queue is not an archive: its
batches are the recovery path for deliveries the main queue gave up on, so a
graph that registered only the main consumer would drop exactly the messages
that had already failed once.

The launcher lives in `.well-known/takosumi.json`, not in the graph. The
withdrawn `takoform_interface` resource used to carry it; a Host now reads the
repository's own install manifest for the launcher and resolves `launch_url`
from this module's ordinary Output.

## Runtime configuration

The module declares what it cannot run without and lets the Host supply it.
`required_sensitive_vars` names `ENCRYPTION_KEY` and the four Takosumi Accounts
OIDC values: the engine refuses to be config-complete without the first, and
Accounts OIDC is the only authentication method on this lane — there is no
password-hash variable to fall back on. No secret value appears in this
directory.

`vars_json` carries the three plain values the Worker reads:

- `YURUCOMMU_RUNTIME_LANE` — the binding shape the Host projects (see below).
- `DELIVERY_QUEUE_NAME` / `DELIVERY_DLQ_NAME` — the engine routes a queue batch
  by comparing `batch.queue` against these, and its built-in fallbacks are the
  _Yurucommu_ queue names. A Yurumeet install that left them unset would accept
  every delivery message and drain none of them.

`APP_URL` is deliberately absent. The endpoint URL is not fed back into the
`WorkerVersion`; the engine establishes the public origin from the first
request and pins it in KV.

### The runtime lane

`runtime_lane` names the binding shape the destination Host projects, not the
tool that published the Worker — the same configuration lands on either kind of
Host, so it cannot be inferred from this being a Takoform module. It defaults to
`cloudflare` (raw `D1Database`, KV namespace, R2 bucket, Queues), which is what
both a plain `wrangler deploy` and the production Takoserver backend project.
A wrapper host sets `portable` and the Worker sees `edge.sql`, `edge.kv`,
`edge.objects`, `edge.queue` instead. The Worker refuses to start when the
declaration disagrees with the bindings that actually arrive.

It is a module variable and deliberately not an install input: the installer
cannot be asked which binding shape their Host projects.

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

Those bytes are what the module deploys: `takoform_worker_bundle` reads
`.generated/yurumeet-worker.js` as module content. Provider 4.0.0 has no
fetch-the-artifact bundle shape, and the module no longer pins a GitHub release
URL — the identity of an install is the repository revision, not a published
asset.

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

`tofu validate` proves the configuration against the Provider's schema. It does
not prove a Host implements these Forms — there is no fake Host to plan
against, so nothing short of a real install exercises create, rollback, and
destroy.

## What this module still owes

The graph is current and validates against the pinned Provider, but it has
never been applied against a live Host. Do not make it selectable in the public
Store until a selected host proves:

1. Worker runtime config and secret injection.
2. Queue producer and consumer registration, including the DLQ consumer.
3. Hourly scheduled invocation of the Worker.
4. Migrations, a stable public URL, accounts OIDC, push configuration,
   destroy, and rollback.

`bun run check:opentofu` is still not chained into `bun run check`. The reason
it was held back — that gating on a withdrawn vocabulary would only lock it in
place — is gone; chaining it, and adding the matching CI step, is the remaining
gate work.

## Focused checks

```bash
bun test scripts/schema-bundle.test.ts \
  scripts/prepare-takoform-v1-source.test.ts \
  scripts/validate-takoform-v1.test.ts \
  scripts/takoform-capsule.test.ts
tofu fmt -check -recursive
```
