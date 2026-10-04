日本語: [README.md](README.md)

# Yurumeet

Unsent text drafts are scoped by server origin, signed-in account and conversation.
Failed storage reads or writes retain the current input across conversation switches
in the same mounted app and show save/reload and text-selection actions. A changed
stored value is preserved until an explicit reload. Unstored input can be lost on
reload or close; this does not promise atomic cross-tab updates or cross-device delivery.
Legacy contact-only drafts remain stored and are not automatically imported because
their author cannot be determined.

Production Workers require a high-entropy `YURUCOMMU_SESSION_HASH_SALT` secret.
The direct OpenTofu adapter requires the sensitive `session_hash_salt` input
when it publishes a Worker and rejects that key in plaintext `env`. Generate
a fresh value securely (for example, `openssl rand -hex 32`) and preserve the
exact existing value on update; changing it can require users to log in again.
Direct managed install's sealed input delivery remains unqualified. The portable
manifest declares a generated-secret binding for fresh installs. Updating an
existing Capsule requires separate platform custody/migration evidence because
a changed generated-secret profile may also regenerate its encryption key.

The Worker refuses missing, blank and known public development-fallback salts
before Core effects, preserving every accepted byte. The code-only publishing
entrypoint requires exactly one `YURUCOMMU_SESSION_HASH_SALT` name in the root
`secrets.required` array of the strict JSON config selected by
`YURUMEET_WRANGLER_CONFIG`, before the gate, D1 check or publication. A plaintext
`vars` entry with that name is refused. The publisher checks required Secret metadata on the actual serving Version
and inherits every binding from that explicit Version ID. Metadata does not
prove a secret value, entropy or custody.

The checked-in `wrangler.jsonc` remains a local development template without a
blanket required-secret list: once such a list exists, Wrangler loads only those
local secret inputs. In the realized publishing config, list the salt and
encryption key plus the secret names needed by the selected authentication
method. Include `AUTH_PASSWORD_HASH` for password auth; do not require it for
an OIDC-only installation. Never put secret values in the config. Adding the
first salt to an existing installation needs a separate credential-owner-reviewed
Secret-setting and re-authentication procedure using that installation's
password or OIDC method. Preserve its encryption key, data and the new salt
through later updates and code rollback; do not convert/delete old sessions to
disguise the required re-login. Local proof does not qualify public custody.

The repository's `bun run deploy -- yurumeet-worker` updates the maintainer's
existing Worker. Its realized strict JSON config must declare root
`name: "yurumeet"` and a lowercase 32-hex-character `account_id`. Self-host users
with other names follow their own deployment runbook. This entrypoint refuses
parent `CLOUDFLARE_ENV` and nonstandard API endpoint overrides, and passes the
empty `scripts/worker-publish-empty.env.example` to every Wrangler invocation.
It does not select the target or credentials implicitly from `.env`/`.env.local`;
authentication comes from the operator's parent process or existing Wrangler
authentication. Any content added to the empty file is refused.

The publisher captures the actual serving Deployment ID and complete traffic map.
Only one Version serving 100% is admitted: split traffic cannot establish one
safe hidden-Secret predecessor and refuses before the gate or upload. Declared
binding names, specified DB/KV/R2 identifiers and jurisdiction, Queue producers,
variables and runtime settings must match actual serving metadata. Optional KV/R2
identifiers may be omitted; actual Version metadata remains their authority.
Newer unserved Versions never become the inheritance source.

Wrangler is used only for `auth token --json`; authentication output is never
printed or saved. The fixed Cloudflare Version and Deployment APIs replace code,
without Secret/resource/settings/route/Cron/Queue-consumer writes. Every binding
uses strict inheritance with an explicit predecessor `version_id`. Version code
is downloaded and its raw module SHA256 compared with reviewed bytes, alongside
full non-code closure/settings readbacks before and after promotion and smoke.
The version-specific content query follows pinned official Wrangler source;
its live API behavior and existing permission scope remain unqualified.

Results retain a credential-free manual Deployment API request restoring the
captured traffic map. Wrangler rollback commands can patch settings and are not
used. Lost write acknowledgements remain indeterminate, without automatic retries
or rollback. Reads are not atomic conditional writes; operators must serialize
updates. Live custody, recovery and user journeys require separate evidence.

The sensitive root `main.tf` input `auth_password_hash` projects a canonical
PBKDF2 hash or unambiguous bootstrap token into the `AUTH_PASSWORD_HASH` Secret.
Nonblank values retain the string OpenTofu receives. Values considered blank
by HCL or Core are omitted and require complete OIDC configuration. PBKDF2-shaped
values with boundary whitespace are rejected during plan: supply the canonical
hash explicitly so it cannot silently become a bootstrap credential.

The previous adapter removed boundary whitespace. Applying this change with a
padded existing bootstrap input changes the credential. To retain the deployed
credential, explicitly provide the value the previous adapter projected, without
exposing it in logs or public configuration. OpenTofu strings undergo NFC
normalization, so this path cannot guarantee original byte preservation for
arbitrary Unicode tokens. Generate new bootstrap tokens securely using ASCII;
if this string path changes an existing value, use the credential owner's
procedure rather than an implicit rotation.

Yurumeet is the LINE-like talk-first fullstack product for the yurucommu family.
`yurume` is the short client id used in server discovery, push registration, and
build scripts.

Yurumeet is a replaceable talk-first UI in the same yurucommu product set. It
embeds the same account, actor, DMs, communities, media, notifications, and
ActivityPub identity engine exposed by `@takosjp/yurucommu-core`.

Yurumeet consumes the shared typed API through `@takosjp/yurucommu-api` and the
server engine through `@takosjp/yurucommu-core/server`. It must not import
unpublished `yurucommu-core` source paths.

## What you get

- Use the same yurucommu account and server API through a talk-first UI
- Access DMs, community chats, timeline, stories, notifications, search, and
  profile
- One fullstack Worker serves the API and UI from the same origin
- Deploy it directly to Cloudflare or install it through Takosumi as a plain OpenTofu module

## UI source

The talk surface is based on `Myoko1110/TakosUI` `talk.html` and
`stylesheet.css`. Keep the `p-talk` / `c-talk-*` DOM shape, bubble-tail assets,
clip button, 78px sidebar, and mobile slide behavior aligned with that source.

Copied TakosUI static assets live in:

- `src/assets/takosui/` for the Yurumeet app
- `site/assets/takosui/` for the product website mock

`public/yurumeet-logo.png` is the served canonical Yurumeet brand logo. Keep
`src/assets/yurumeet-logo.png` for the app bundle and
`site/assets/yurumeet-logo.png` for the product website byte-identical to it.
`bun run check` verifies all three PNG copies.

## Local development

```sh
bun run dev
bun run dev:mock
```

Vite serves the client on `http://localhost:5174` and proxies `/api` and
`/.well-known` to `http://localhost:8787`.

`bun run dev:mock` starts Yurumeet and an in-memory yurucommu-compatible mock API
together. The mock uses the same `/api/auth/me` and `/api/auth/login` password
auth shape as Yurucommu, then serves talk contacts, community chats, timeline,
stories, notifications, search, and profile data for UI development. If 8787 is
already in use, the script automatically picks the next free mock API port and
updates the Vite proxy target.

Use `bun run check` for type checking and `bun run lint` for linting (both run
the same `tsc --noEmit` under the hood).

`bun run check` is the complete repository gate for formatting, types, tests,
portable build and artifact smoke. An additional browser check uses installed
Chrome and the Worker produced by that gate.

The artifact and browser smoke run Miniflare under Node.js, so `bun run check`
also uses Node.js 24.21.0; CI pins the same version. Bun handles install,
type checking, tests and builds.

```sh
bun run smoke:release-browser -- dist/takos-worker.js
```

Set `BROWSER_SMOKE_CHROME` to specify the executable. The script does not download
a browser and fails if Chrome is unavailable. CI also requires this step after
the complete `check`. It verifies actual form rejection, retry, the signed-in
persisted sessions and actual UI contact selection, DM, image/video attachment
and retry after interruption before the request reaches the server, with disposable local HTTP and native bindings, checking
the persisted DB and ObjectBucket data. The synthetic communication peer is
added only after first-login qualification. It also checks response loss after a
message is saved. The UI reports unconfirmed delivery and warns that another send
may duplicate it; the current Core/API cannot guarantee duplicate prevention.
Hiding the unconfirmed placeholder removes its local display, not a saved server
message.
Public TLS, OIDC, cross-server communication and update/recovery need separate
evidence.

Artifact smoke also closes and clones the same current Worker's native D1/KV/R2
stores, comparing every file path, size and SHA before reopening the clone. It
checks the original cookie, schema/data, post/media bytes, Core KV origin pin
and unchanged original snapshot. This disposable same-artifact fixture requires
separate evidence for published-version upgrades, live backup, Secret custody
and OIDC recovery.

## Runtime API

The bundled fullstack Worker serves the API and UI from the same origin by
default. Yurumeet opens the same yurucommu account and API through the
talk-first UI. Development builds can still override the API origin in this
order:

1. `?server=https://your-yurucommu.example`
2. `VITE_YURUME_SERVER_URL` at build time
3. `localStorage["yurumeet.serverOrigin"]`
4. same-origin fallback

The override path is for local UI work and unusual self-host layouts. Normal
runtime packaging keeps Yurumeet and the yurucommu-compatible API together.

The server must allow the Yurumeet origin in CORS / CSRF settings, for example:

```text
CSRF_ALLOWED_ORIGINS=https://talk.your-yurucommu.example
```

## Build and deploy

```sh
bun run build
bun run build:takos-worker
```

The production client build writes to `dist/`. `bun run build:takos-worker`
embeds those assets with the core backend into `dist/takos-worker.js`.

Yurumeet owns both a direct Cloudflare module and a portable Takoform Capsule,
but their public availability is not the same. Cloudflare self-hosting is
available now. The Takosumi managed-install link stays disabled until a live
create, rollback, and destroy evidence set exists.

### Self-host on Cloudflare

This deployment is owned by the end user or their operator; it is not an
official production target operated by us. `wrangler.jsonc` and the root
OpenTofu module define the direct Cloudflare path, while credentials, approval,
migrations, and recovery remain under that operator's runbook and authority.

`wrangler.jsonc` is also the single source for the Worker compatibility date
and flags. The root `main.tf` decodes that file, so keep it as strict JSON
without JSONC comments or trailing commas. The D1 migration record remains
`yurucommu_migrations`, shared with the core runners, and retention runs hourly.
`deploy/takoform/` declares no compatibility at all: which runtime serves the
Worker is the host's decision, and the portable module states only which
handlers the Worker exports.

### The three surfaces this repository publishes

Three things are published officially, through one deploy entrypoint. The shared
rules live in the sibling `takos-control` repository (`engineering.policy.json` →
`deploy`):

```sh
bun run deploy -- yurumeet-worker
bun run deploy -- yurumeet-worker-release [--dry-run|--execute]
bun run deploy -- yurumeet-site --environment=integration|production
```

`bun run deploy -- --contract` answers, without side effects, what each surface
publishes and how it discharges every obligation it owes.

Only `yurumeet-worker-release` mints an identity consumers pin. It derives one
tag from `package.json`, and refuses to start when that tag or its Release
already exists, or when `package.json`, the root module's tag default, the
append-only `release.lock.json`, `.well-known/takosumi.json`, and
`deploy/takoform/`'s source build do not name the same release. `bun run check`
asks that same question of every commit.

Before publishing, `yurumeet-worker` reads DB metadata selected by the realized
strict JSON config in `YURUMEET_WRANGLER_CONFIG`, using the existing Wrangler
credential. It checks the columns, primary key and due index required by Core
4.1.11's additive migration `0030`. Missing or inconsistent metadata, denied
reads and invalid responses stop publication. This checks that specific contract;
it does not qualify the whole schema or migration ledger, apply migrations or
grant permissions. The root direct-Cloudflare module's Apply is a separate path
requiring reviewed pre-applied schema evidence. Environment selection via
`CLOUDFLARE_ENV` is unsupported and rejected; a changed config after inspection
also stops publication. The portable module applies
schema before updating its Worker.

None of the three falls back to a raw Worker deployment or a migration, and none
mutates a durable store (D1 DB / KV / R2 MEDIA). Publishing the site is
documented in [`site/DEPLOY.md`](site/DEPLOY.md).

### Managed install through Takosumi (not yet public)

The canonical managed graph is `deploy/takoform/`. Do not publish an install
link until a fixed release containing that module and host-conformance evidence
are available:

```json
{
  "url": "https://github.com/tako0614/yurumeet.git",
  "ref": "<verified-release-tag>",
  "path": "deploy/takoform"
}
```

Takosumi owns Plan, Apply, StateVersion, Output, and Audit on this path. The
root `main.tf` is the direct Cloudflare module and is not the module selected by
the managed-install CTA.

`.well-known/takosumi.json` is `takosumi.com/v2.4` and declares both of this
repository's modules: the root direct-Cloudflare one and `deploy/takoform/`.
Declaring a module and offering it are different acts — the public CTA stays
closed until the conformance evidence exists.

The `deploy/takoform` install asks the installer for no secret at all. The host
generates `ENCRYPTION_KEY` and delivers the Accounts OIDC issuer, client, owner
subject, and redirect URI as runtime bindings. The manifest carries slot names,
never values.

Both modules expose `launch_url` and `api_url` as ordinary OpenTofu runtime URL
outputs. The root module's remaining outputs are provider-native operational
values for the Cloudflare resources it creates. Takosumi's service-side
InstallConfig maps `launch_url` into the launcher Interface and owns the D1
migration lifecycle action. Neither module uses reserved `takosumi_release`,
`app_deployment`, `service_exports`, or `service_bindings` outputs as runtime
declarations or lifecycle authority.

Yurumeet is software, not a centrally hosted app. `https://yurumeet.com` is only
the product/landing site in `site`; it is not the installed runtime.

## Browser notifications

Browser notifications are an explicit opt-in in Settings. Merely opening the
app never prompts for notification permission. Pushes contain no DM or
community-message content; the service worker wakes the client and opens
Yurumeet.

When OpenTofu creates the Worker, configure these variables:

- `notification_push_gateway_url` — public HTTPS notify endpoint of the
  stateless push gateway
- `notification_push_gateway_token` — secret bearer used only by the Worker
  when it calls that gateway
- `notification_push_web_push_public_key` — the gateway's public VAPID key
  (not a secret)

The gateway URL and public VAPID key must be configured together. Keep the
matching VAPID private key only at the gateway; it is never stored in the
Yurumeet database, browser, or OpenTofu outputs. For local UI development
against an older server only, `VITE_YURUME_NOTIFICATION_PUSH_GATEWAY_URL` and
`VITE_YURUME_WEB_PUSH_PUBLIC_KEY` provide a build-time fallback.

## Developer notes

Load the typed shared API through `@takosjp/yurucommu-api` and the server
engine through `@takosjp/yurucommu-core/server`. Do not import from the
unpublished `yurucommu-core` source path.
