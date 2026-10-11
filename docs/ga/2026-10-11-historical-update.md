# Published v0.1.2 historical update fixture

This optional native qualification exercises the published Yurumeet v0.1.2
Worker and Core 3.2.0's original 19 SQL files, followed by the published Core
4.1.14 migration runner and the candidate Worker. It creates disposable local
D1/KV/R2 stores; it never queries or changes an operator database.

## Inputs and command

Use Node 24.21.0, the frozen dependency lock, and the public inputs pinned in
[`historical-v012-fixture.json`](../../scripts/historical-v012-fixture.json).
Download `worker.js` and `takosumi-artifact.json` from the
[v0.1.2 Release](https://github.com/tako0614/yurumeet/releases/tag/v0.1.2), and the
public `@takosjp/yurucommu-core@3.2.0` tarball. Extract its original 19
`package/migrations/*.sql` members into a separate directory without modifying
their bytes. The fixture refuses mismatching Worker/manifest/tarball/SQL hashes,
an incomplete SQL set, and a candidate without an explicit SHA-256.

Build the candidate with `bun run build:takos-worker`, then pass all six inputs:

```text
bun run smoke:release-update <candidate.js> <sha256:candidate-digest> <v0.1.2-worker.js> <old-19-sql-directory> <public-core-3.2.0.tgz> <v0.1.2-takosumi-artifact.json>
```

The native run requires the public fixture bytes and local workerd capability,
so it is a separate cadence from `bun run check`. Portable admission and typed
row-comparison regression tests are included in the normal test command. CI's
current-schema browser and restore checks remain separate evidence.

## Assertions and observed local result

The supervised local run on 2026-10-11 passed with candidate Worker SHA-256
`95967098d94de8242a931da1783350d76a75b8e04daf2397905a48c4482a9f4c`,
the published v0.1.2 Worker
`12dbf659613caa79c7e1696cb44a6078216bba92e61e812d3e84cd8d23370472`, and
Core 4.1.14. The checks cover:

- Actual local Wrangler-created `d1_migrations` rows for all 19 original SQL
  files, and the old notification-push schema with its actor cascade FKs.
- Password login, Note and PNG creation/readback through the old Worker API;
  native seeded push registrations and pending/retry/queued jobs.
- Closed D1/KV/R2 backup clones, old Worker backup reopen, and complete old
  snapshot comparison before migration.
- A fixture-only adapter which validates the physical 19-row ledger and old
  push definitions before importing those exact rows and timestamps into the
  public runner's `yurucommu_migrations` ledger. Each runner-provided SQL file
  and its ledger mark execute in one native D1 batch. An injected failure after
  the first pending script proves its schema and ledger mark roll back.
- The public runner skips 19 files and applies 16 to reach 35; 0036 removes
  historical push actor FKs while retaining all seeded row/retry fields, global
  device uniqueness and the required push guard/inbox triggers. Visible old
  column values in 43 tables are compared without dropping duplicate rows or
  confusing native BLOB bytes with text. Foreign-key checks remain clear.
- Complete bounded KV/R2 key and byte inventories, unchanged closed source
  stores, and candidate reopen without extra schema or fixture writes. With an
  explicitly changed synthetic session salt, the old cookie is refused;
  password re-login reaches the same actor, Note and PNG. This does not imply
  every update should rotate an existing operator's session salt.

The inner process-group supervisor bounds the run to 11 minutes. Success emits
one PASSED JSON manifest. Failure emits a bounded FAILED label and a nonzero
exit; it does not report success or print SQL, credentials or row values. The
temporary synthetic stores are removed after the run.

## Evidence limits

This is a local populated 19-to-35 update fixture, not a production migration
adapter or a policy for adopting an operator's ledger. The original historical
0003 SQL is used; a later product-specific Takoform override is not substituted.
The old and current 0019 files share a name but have different hashes; exact old
schema checks and 0036 repair assertions are therefore mandatory.

No published historical schema-bundle digest was available; provenance comes
from the actual release bytes, tarball integrity, individual SQL hashes and
observed native ledger/schema. Running the old Worker on the new schema, old
OIDC continuity, real issuer integration and real operator backup/update/restore
are not exercised. Queue/Cron delivery, public Host/TLS, native devices/store,
and full product GA need their own evidence. No product Release, live deploy,
credential or real-data change is performed. This fixture does not define a
single-owner policy for Yurumeet.
