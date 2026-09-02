# Changelog

## Unreleased

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
