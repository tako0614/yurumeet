# AGENTS.md — Yurumeet

Yurumeet is the LINE-like talk-first fullstack product for the yurucommu family.
`yurume` is the client id / short name used for discovery and mobile push
registration.

This repo owns the client UI, `yurumeet.com` product site, Worker artifact,
direct Cloudflare deployment, and plain OpenTofu Capsule. It embeds the shared server engine from
`@takosjp/yurucommu-core` and consumes the typed API through
`@takosjp/yurucommu-api`.

## Workflow

```bash
bun install
bun run check
bun run test
bun run build
bun run build:takos-worker
# only when publishing a real Cloudflare instance
bun run deploy
```

Cloudflare direct deploy and Takosumi install are equal product entrypoints.
`wrangler.jsonc` owns direct Cloudflare bindings; `main.tf` owns the
Takosumi-managed OpenTofu path. Direct Cloudflare users must not need OpenTofu.

## Version discipline

`package.json` and the `worker_release_tag` default in `main.tf` describe the Yurumeet product release.
Keep early product work on the existing version stream unless there is an
explicit release decision; dependency or repo topology changes alone are not a
major release reason.
