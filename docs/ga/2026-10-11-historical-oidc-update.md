# Published historical OIDC update — 2026-10-11

This separate OIDC-only fixture exercises the published Yurumeet v0.1.2 Worker
and original Core 3.2.0 schema before a 19-to-35 update using the published Core
4.1.14 runner. It uses a synthetic local issuer and disposable native stores.
The existing password historical fixture remains a separate case.

Local qualification completed on 2026-10-11. The owning complete gate passed
483 tests, zero failures and 26 OpenTofu tests. Four native manifests refer to the
actual candidate Worker SHA256
`3b952ec6c0ee048bfd303344f8053c21c01ae8bdca780db57c908c6e171d1bd0`.
On the same source and bytes, the separate OIDC historical CLI passed 17 checks;
the existing password historical CLI passed its 14 checks. Retain these actual
run manifests separately from hosted CI, browser and live-service evidence.

Use the same six explicit, pinned public inputs described in
[the password historical update](2026-10-11-historical-update.md):

```sh
bun run smoke:release-oidc-update <candidate.js> <sha256:candidate-digest> <v0.1.2-worker.js> <old-19-sql-directory> <public-core-3.2.0.tgz> <v0.1.2-takosumi-artifact.json>
```

The old Worker and Core tarball must match the checked-in historical fixture
pins. The test uses the original old `0003` SQL, not the later Takoform override.
The fixture-only ledger adapter must validate the real Wrangler-created 19-row
ledger and old schema before invoking the public runner. It is not a production
ledger-reconciliation procedure.

Required observations are:

- The actual old Worker advertises OIDC without a password fallback and completes
  a PKCE/nonce/JWKS authorization-code callback. Its explicit owner pin uses the
  old provider-scoped `takos:<subject>` identity. This pins the disposable test
  identity and does not define a Yurumeet-wide single-owner policy.
- A wrong nonce and callback replay are refused by the old Worker. A valid but
  unallowed subject reaches the old and candidate callbacks and fails before
  creating an actor or session. The candidate wrong-nonce case is not measured
  by this historical fixture. Unexpected outbound destinations are
  refused; only the exact synthetic issuer endpoints are available.
- One nondevelopment session salt and encryption key are retained across the old
  Worker, independent old backup, migration and candidate. Old cookie lookup,
  linked identity and encrypted provider-token rows are observed without logging
  cookies, tokens, keys, state, nonce, ciphertext or full rows.
- Independent closed old backup restores the old cookie, owner, Note and PNG
  through the old Worker. The old Worker is not opened against the new schema.
- The real 19-skipped/16-applied/35-ledger transition preserves the complete old
  visible-row projection and bounded KV/R2 inventories, including the encrypted
  session fields. Existing atomic-batch failure and schema checks remain active.
- The candidate clone matches the migrated snapshot before authentication writes.
  With the retained salt, the old cookie must resolve to the same actor. A 401 is
  a continuity failure to diagnose, rather than an assumed upgrade policy.
- Same-subject reauthentication rotates the session without creating a duplicate
  actor. The old cookie is retired, the new session belongs to the same identity,
  and Note/media data remain accessible. Compare preserved rows before rotation
  separately from the intended authentication writes afterward.
- Owned writers close and original closed stores remain unchanged. Success and
  failure clean up only disposable fixture resources.

The password fixture intentionally changes from the old development-fallback
salt to a new synthetic salt and requires re-login. That test-specific refusal
does not replace this retained-salt continuity case or recommend changing an
operator's salt during normal updates.

Synthetic ciphertext checks do not prove provider refresh-token use, a real
issuer or Workspace grant. Custom historical/Takoform lineages, real operator
custody and backup/update/restore, published Host/Provider lifecycle, live
Queue/Cron/federation, native devices/store and full GA require separate evidence.
This test creates no product Release, production deployment or authentication
grant.
