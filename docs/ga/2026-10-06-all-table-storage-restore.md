# Yurumeet complete logical restore comparison — 2026-10-06

The existing native storage drill copies closed disposable D1, KV and R2 stores,
checks their exact file bytes, and reopens the same built Worker artifact. Its
logical D1 comparison previously selected only actors, sessions, objects,
media_uploads and activities. A changed delivery, push, job or ledger row could
therefore escape the logical comparison.

The comparison now discovers application tables from the actual SQLite schema
and fingerprints every visible or generated column and every row, including new application
tables. Hidden virtual-table columns are omitted; their physical shadow tables
remain included. Row order does not affect the fingerprint; duplicate rows remain
significant. Unsafe integer values from the D1 JavaScript adapter refuse the
snapshot, since rounded readback cannot prove preservation. Table identifiers are quoted. Failed reads are errors, not skipped
tables. The native runtime's explicitly named private metadata table is excluded
from row and foreign-key reads and reported separately. Application migration
ledgers, when present, receive the same comparison as other application tables.

Schema definitions, foreign-key relationships, per-table foreign-key integrity
and sqlite_sequence state accompany the row fingerprint. The successful restore
manifest reports table coverage and counts without exposing row contents, keys,
session cookies or provider tokens. A corrupt foreign-key relation refuses the
snapshot rather than contributing to a passing restore result.

The first clone comparison is exact, including sessions and actor timestamps.
The subsequent synthetic OIDC reauthentication checks permit only session rows
and the existing fixture actor's updated_at login timestamp to change. That
timestamp still has to be valid, monotonic and bounded by the actual login. The
other application data remains subject to the complete comparison. The fixture's
one actor is test setup and does not establish a Yurumeet single-owner policy.

Regression controls exercise data outside the original five tables, sequence
drift, referential corruption and failed reads. The owning `bun run check`
qualifies this source and the product's own built artifact; local native D1,
portable SQL and hosted CI results are recorded separately.

This remains a fresh current-schema, same-artifact restore drill. It does not
apply a historical migration ledger through the product's migration runner,
update existing operator data, prove a real issuer integration, or qualify
published application assets, a Provider/Host, remote D1 or a live deployment.
Those remain separate GA dependencies. Package pins, schema, production state
and release identities are unchanged.
