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

## UI source

The talk surface is based on `Myoko1110/TakosUI` `talk.html` and
`stylesheet.css`. Keep the `p-talk` / `c-talk-*` DOM shape, bubble-tail assets,
clip button, 78px sidebar, and mobile slide behavior aligned with that source.

Copied TakosUI static assets live in:

- `src/assets/takosui/` for the Yurumeet app
- `site/assets/takosui/` for the product website mock

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

## Build and install

```sh
bun run build
bun run build:takos-worker
```

The production client build writes to `dist/`. `bun run build:takos-worker`
embeds those assets with the core backend into `dist/takos-worker.js`.

Install this repo through Takosumi as a normal plain OpenTofu module:

```text
repositoryUrl = "https://github.com/tako0614/yurumeet.git"
modulePath    = "."
```

Yurumeet is software, not a centrally hosted app. `https://yurumeet.com` is only
the product/landing site in `site`; it is not the installed runtime.

The landing site has its own deploy notes in `site/DEPLOY.md`.
