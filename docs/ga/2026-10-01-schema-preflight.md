# Direct Worker schema preflight — 2026-10-01

Task: GA-20261001-meet-schema-preflight, Yurumeet only, after Core/API
consumer alignment #24. The parent owns this ledger and README JA/EN; a bounded
worker owns scripts/deploy.mjs, the new readiness helper and meaningful tests,
package.json test registration and deploy-contract.test.ts. No other worktree,
shared Core/API/provider, schema SQL/bundle, permission or credential changes.
No cloud command, migration, live deployment or real-data mutation is authorized.

Problem: direct code-only Worker publication can replace Core 4.1.7 with 4.1.11
without checking that additive 0030 exists in the bound DB. The portable
Takoform module already orders schema application; the separate root Cloudflare
Apply path remains outside this entrypoint's guarantee.

Before direct Worker publication, parse the operator's realized strict JSON
config and require one concrete DB binding. Query only SQLite table/index
metadata using that exact config and existing Wrangler credential. Verify
0030's required columns, primary key and due-index key order. This is a
specific 0030 readiness contract, not whole-schema or migration-ledger proof.
Unreadable/denied/invalid or missing/malformed metadata must stop publication.
Do not grant query permission, create resources, apply SQL, use the stale live
_cf_migrations ledger, or retry automatically.

The deploy mechanism change requires independent review. Tests must exercise
the actual entrypoint with isolated subprocess command mocks and prove that
blocked scenarios never invoke Wrangler deploy. Positive metadata must use
the same realized config for query and publish and retain the existing
provenance, version readback and post-condition sequence. Contract discovery
must remain side-effect-free. Complete the read-only owner gate serially,
record source/artifact identities, commit/PR, exact-tree CI and remaining
direct-Apply/public lifecycle conditions before integration handoff.
