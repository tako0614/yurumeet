# Published Core/API alignment — 2026-10-01

Task GA-20261001-meet-core-alignment, Yurumeet only, after #23. The consumer
worker owns package/lock, release floor/tests and generated schema outputs.
Parent owns this ledger, independent review, serialized full gate, artifact
and mixed-native verification, commit/PR and integration handoff. Original
message-search dirty work, Yurucommu, Core, control and other worktrees remain
untouched. No new permission, cloud resource, publication, live migration or
deployment is performed. Yurucommu's single-human-owner premise is not imposed
on Yurumeet by this change.

The actual mixed native fixture with Yurucommu Core4.1.11 and Yurumeet Core4.1.7
fails in both Follow directions. Yuru→Meet reaches the real signed Follow inbox
but gets401 while Meet logs native DNS ENOTFOUND when fetching the signer's key.
Meet→Yuru fails remote-actor lookup before peer HTTP. Source4.1.11 already has the
Workers-first DoH resolver branch; the existing published release can be consumed
without requesting a new Core backport or changing the shared resolver here.
These local .invalid-name observations do not qualify public DNS/TLS behavior.

Raise both product dependencies/lock and the release floor to4.1.11. API/Core
exports used by this product remain available. Regenerate the product-owned
schema bundle and SQL from the integrity-pinned installed Core:29 migrations,
the previous28 byte hashes unchanged, plus0030_media_blob_deletion_jobs.sql.
The new table/index records durable blob-deletion retry intents. Provider4.0.0
and the product's required runtime resource graph remain unchanged.

Future installation/update must apply the additive schema before serving the
new Worker. Verify the existing module dependencies and source preparation,
then exercise old28→new29 on disposable native D1 with existing product data
and a failed/successful blob-deletion retry. No production migration is authorized
by this ledger. Reversal retains the new table and pending intents; old Core
ignores them, so deletion retries may wait until forward repair. Do not drop the
table or discard intent rows to make a rollback look clean. Existing D1 migration
ledger hazards remain in force.

Require independent source review, explicit fmt, full read-only bun run check
with unchanged tracked/nonignored-untracked source fingerprints, native/browser
checks against the same built bytes and exact-head terminal CI. Repeat mixed
signed Follow/Accept in both directions using those immutable product artifacts
and actual queue producers/brokers/consumers; no seeded relationships or synthetic
success responses. Local/native/CI success cannot close public self-install,
real Queue/Cron, authority continuity or update/restore deployment conditions.

Initial focused consumer checks:15 pass, Core release floor passes, scripts-disabled
frozen-lock install resolves only Core/API4.1.11. Record final qualification and
its exact commit/artifact in the separate integration handoff.
