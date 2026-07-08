# Publishing the Yurumeet website

`site/` is the static landing site for Yurumeet. The runtime UI source lives in
`src/` and is bundled with the Yurumeet app build.

There is no site build step. Upload the directory as-is to the static hosting
target you use for the product-facing website. Cloudflare Pages is one valid
target:

```sh
bunx wrangler pages deploy site \
  --project-name=yurumeet-website \
  --branch=main
```

Attach the custom domains `yurumeet.com` and `www.yurumeet.com` to that Pages
project, then create proxied CNAME records in the `yurumeet.com` zone:

```text
CNAME  yurumeet.com (@)      -> yurumeet-website.pages.dev
CNAME  www.yurumeet.com      -> yurumeet-website.pages.dev
```

Keep this site product-facing only. The app UI source is under `src/`, and
runtime API wiring belongs to same-origin Worker packaging, discovery metadata,
and OpenTofu outputs.

Do not publish a central app subdomain runtime from this site. Yurumeet is
software that runs from a user's Takosumi install, Cloudflare deployment, or
self-host runtime. A self-hoster builds the Yurumeet Worker with `bun run
build:takos-worker` and serves the UI/API set from their chosen origin.
