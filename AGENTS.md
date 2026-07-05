# AGENTS.md — Yurumeet

Yurumeet is the LINE-like talk client for yurucommu-core. `yurume` is the client
id / short name used for discovery and mobile push registration.

This repo owns only the client UI and `yurumeet.com` product site. It consumes
`@takosjp/yurucommu-api` and discovers a yurucommu-core server through
`/.well-known/social-server`, explicit URL configuration, or Takosumi Capsule
outputs.

## Workflow

```bash
bun install
bun run check
bun run build
```
