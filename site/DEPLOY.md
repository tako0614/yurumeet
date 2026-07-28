# Publishing the Yurumeet website

`site/` is the static landing site for Yurumeet. The runtime UI source lives in
`src/` and is bundled with the Yurumeet app build.

There is no site build step. The official ecosystem target currently has no
runnable `yurumeet-site` adapter, so official publication remains fail-closed
until a fixed adapter with authoritative readback is registered.

```sh
# from the sibling takos-control repository, once the adapter exists
bun run deploy
```

`prepare` is read-only. Do not substitute a raw Pages upload when the adapter is
missing. A self-hoster may publish a copy to infrastructure they own, under
their own credentials, approval, and recovery policy; that action is not an
official ecosystem release.

The official Pages target uses the custom domains `yurumeet.com` and
`www.yurumeet.com`:

```text
CNAME  yurumeet.com (@) -> yurumeet-website.pages.dev
CNAME  www.yurumeet.com -> yurumeet-website.pages.dev
```

Domain and DNS changes are operator-owned provisioning actions, not release
steps.

Keep this site product-facing only. The app UI source is under `src/`, and
runtime API wiring belongs to same-origin Worker packaging, discovery metadata,
and OpenTofu outputs.

Do not publish a central app subdomain runtime from this site. Yurumeet is
software that runs from a user's Takosumi install, Cloudflare deployment, or
self-host runtime. A self-hoster builds the Yurumeet Worker with `bun run
build:takos-worker` and serves the UI/API set from their chosen origin.
