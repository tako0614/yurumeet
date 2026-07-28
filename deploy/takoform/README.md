# Yurumeet Takoform Capsule

This directory is the canonical managed-resource definition for Yurumeet. It
uses Takoform resources directly and does not point a Cloudflare provider at a
Takosumi compatibility endpoint.

The selected Worker release URL and SHA-256 are pinned in this Capsule. A
product release updates the tag, URL, and digest together.

The root OpenTofu module remains the supported direct-Cloudflare deployment
path. Both modules select the same signed release artifact, but they have
different authorities:

- `main.tf` at the repository root owns a direct Cloudflare installation.
- `deploy/takoform/` declares the portable resource graph consumed by a
  Takoform host.
- Takosumi owns install lifecycle, target selection, credentials, secrets,
  migrations, public URLs, and rollback.

The Capsule intentionally asks for queue `consume` and `publish` permissions
and a `Schedule -> EdgeWorker` trigger. A host must reject the installation
until it can materialize those requirements. It must not silently downgrade
them.

Do not make this module selectable in the public Store until the pinned
Takoform provider/Form package is published and the selected host proves:

1. Worker runtime config and secret injection.
2. Queue producer and consumer registration, including the DLQ consumer.
3. Hourly scheduled invocation of the Worker.
4. D1 migrations, a stable public URL, accounts OIDC, push configuration,
   destroy, and rollback.
