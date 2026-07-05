# Yurumeet

Yurumeet is the LINE-like talk client brand for `yurucommu-server`. `yurume` is
the short client id used in server discovery, push registration, and build
scripts.

The client is intentionally separate from the feed-first Yurucommu web UI. It
uses the same account, actor, DMs, communities, media, notifications, and
ActivityPub identity exposed by yurucommu-server.

Yurumeet consumes the shared typed API through `@takosjp/yurucommu-api`. It
must not import `yurucommu-core` server repo internals; the npm package and
yurucommu-core discovery outputs are the only required API contract.

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
```

Vite serves the client on `http://localhost:5174` and proxies `/api` and
`/.well-known` to `http://localhost:8787`.

## Server selection

Yurumeet can run on a separate domain from the social server. The client resolves
the yurucommu-server origin in this order:

1. `?server=https://your-yurucommu.example`
2. `VITE_YURUME_SERVER_URL` at build time
3. `localStorage["yurumeet.serverOrigin"]`
4. same-origin only for local dev hosts (`localhost`, `127.0.0.1`,
   `yurume.test`, `*.yurume.test`, `yurumeet.test`, `*.yurumeet.test`)

If no server is configured, the first screen asks for a yurucommu-server URL.

The server must allow the Yurumeet origin in CORS / CSRF settings, for example:

```text
CSRF_ALLOWED_ORIGINS=https://talk.your-yurucommu.example
```

## Build and install

```sh
bun run build
```

The production build writes to `dist/`. Yurumeet is software, not a centrally
hosted app. Publish that directory through your own Takosumi Capsule,
Cloudflare Pages/Workers route, or self-host runtime, then point it at the
yurucommu-server origin for that installation.

`https://yurumeet.com` is only the product/landing site in
`site`; it is not the runtime client.

The landing site has its own deploy notes in `site/DEPLOY.md`.
