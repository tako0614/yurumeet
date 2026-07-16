日本語: [README.md](README.md)

# Yurumeet

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

Yurumeet has two equal installation paths.

### Deploy directly to Cloudflare

Use [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurumeet),
or deploy from an authenticated CLI:

```sh
bunx wrangler d1 create yurumeet-db
bunx wrangler queues create yurumeet-delivery
bunx wrangler queues create yurumeet-delivery-dlq
bunx wrangler secret put ENCRYPTION_KEY
bunx wrangler secret put AUTH_PASSWORD_HASH
bun run deploy
```

`wrangler.jsonc` is the source of truth for direct deployment. `bun run deploy`
builds the fullstack Worker, applies the shared core D1 migrations, and runs
`wrangler deploy`. Deploy to Cloudflare also provisions D1, KV, R2, and Queues.

### Install through Takosumi

Install this repo through Takosumi as a normal plain OpenTofu module:

```json
{
  "url": "https://github.com/tako0614/yurumeet.git",
  "ref": "main",
  "path": "."
}
```

OpenTofu belongs to the Takosumi-managed path because it adds Plan, Apply,
StateVersion, Output, and Audit management. A direct Cloudflare deployment does
not require OpenTofu.

Yurumeet is software, not a centrally hosted app. `https://yurumeet.com` is only
the product/landing site in `site`; it is not the installed runtime.

The landing site has its own deploy notes in `site/DEPLOY.md`.

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
