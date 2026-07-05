# Publishing the Yurumeet website

`clients/yurume/site/` is a static landing site for Yurumeet. It is separate from
the runtime client. The runtime client source lives in `clients/yurume/src` and
builds into `dist-yurume/`.

There is no site build step. Upload the directory as-is to the static hosting
target you use for the product-facing website. Cloudflare Pages is one valid
target:

```sh
# from yurucommu/
bunx wrangler pages deploy clients/yurume/site \
  --project-name=yurumeet-website \
  --branch=main
```

Attach the custom domains `yurumeet.com` and `www.yurumeet.com` to that Pages
project, then create proxied CNAME records in the `yurumeet.com` zone:

```text
CNAME  yurumeet.com (@)      -> yurumeet-website.pages.dev
CNAME  www.yurumeet.com      -> yurumeet-website.pages.dev
```

Keep this site product-facing only. The app client source is under
`clients/yurume/src`, and server/client connection metadata belongs to
yurucommu-server discovery and OpenTofu outputs.

Do not publish a central app subdomain runtime from this site. Yurumeet is
software that runs from a user's Takosumi install, Cloudflare deployment, or
self-host runtime. A self-hoster builds `dist-yurume/` with `bun run
build:yurume` and serves it from their own chosen origin.
