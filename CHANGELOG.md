# Changelog

## Unreleased

- Adopt Core/API 4.2.1. A fresh managed install creates its first owner
  again: since 2026-10-29 Takosumi Accounts adds `app_role` to the signed
  `takosumi` ID-token claim, which Core 4.2.0 and earlier refused, so the first
  sign-in was rejected. Existing instances were unaffected. Migrations are
  unchanged.

- Adopt Core/API 4.2.0. The server sends standard Web Push itself with a VAPID
  key derived from `ENCRYPTION_KEY`, so browser notifications need no push
  gateway or hand-entered key. The service worker shows Declarative Web Push
  and opens only same-origin pages. The ignored
  `notification_push_web_push_public_key` variable and the `VITE_YURUME_*`
  build-time push fallback are removed; the gateway URL remains for native app
  pushers. Migrations are unchanged (35 files, byte-identical to Core 4.1.14).

## 0.2.0 - 2026-10-12

- Adopt the published Core/API 4.1.14 and its 35-migration schema bundle,
  including authentication revocation, media deletion fencing and guarded SQL
  fixes. Existing deployments must preserve their session hash salt and
  encryption key and follow the owning schema/update procedure.
- Validate the full-stack Worker through native D1, Queue and browser fixtures,
  including federation signatures, actor binding, delivery retries, foreign
  activity identifiers and private-network request refusals.
- Rehearse populated v0.1.2-to-current password and synthetic OIDC update/restore
  paths without changing a real installation. These fixtures do not establish
  a real issuer, physical-device or production-runtime qualification.
- Publish an immutable Worker from one clean source commit, verify the exact
  candidate and downloaded bytes, and append the actual release lock after
  publication. Managed installation remains closed pending Host conformance.

- Raise the `@takosjp/yurucommu-core` / `-api` floor to 4.1.5 and make
  `bun run check:core-release` part of `bun run check`, so a release that lacks
  a required export fails a commit instead of a deployment.
- Compose the Worker entry through the declared runtime lane, and let the engine
  own public-origin establishment. The product-local `APP_URL` shim used to make
  the origin always look configured, so the canonical origin was never pinned in
  KV and background deliveries had no origin at all.
- Give the portable lane a schema authority: a generated migration bundle with
  per-file digests, the Worker bytes embedded as module content, and the one
  Takoform override that keeps a D1-safe migration atomic on a host that
  enforces foreign keys.
- Rewrite `deploy/takoform/` onto Takoform provider 4.0.0. Every resource type
  the old module declared had been withdrawn, so no install could have run.
- Describe both modules in a `takosumi.com/v2.4` repository manifest and retire
  `install-options.json`.
- Own the two deploy surfaces that had no entrypoint: `yurumeet-worker-release`
  (create-only, immutable GitHub Release with exact readback) and
  `yurumeet-site` (Cloudflare Pages with immutable and public readback).
- Chain `bun run check:opentofu` into `bun run check` and install OpenTofu in
  CI. Nothing in the gate had looked at the OpenTofu modules, which is why a
  module pinning a withdrawn vocabulary stayed green.

## 0.1.2 - 2026-07-19

- Publish the optional Capsule Source Options chooser for the existing
  Cloudflare OpenTofu module.

## 0.1.1 - 2026-07-16

- Make Takosumi migration-only activation materialize core dependencies on a fresh runner checkout.

## 0.1.0 - 2026-07-16

- Ship the first Yurumeet talk-first fullstack Worker release.
- Support Takosumi Accounts OIDC alongside bootstrap password login.
- Include home, talk, timeline, Story, profile, community, notification, bookmark, moderation, and browser push surfaces.
- Add direct Cloudflare and Takosumi-managed OpenTofu deployment paths.
- Add a post-deploy functional probe for shell, health, discovery, authentication, timeline, talk contacts, and notifications.
