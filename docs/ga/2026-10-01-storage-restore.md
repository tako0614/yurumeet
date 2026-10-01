# Yurumeet closed native storage restore — 2026-10-01

Scope: Yurumeet only, stacked after qualified PR #28. One worker owns the new
release-storage-restore module/declaration and exact copies of Yurucommu's
qualified native-runtime-stdio helper/declaration. The parent owns native-smoke
integration, existing smoke tests, README JA/EN, this ledger, serial validation
and handoff. A separate worker extends only a copied operator continuity probe.
No shared Core/control, original dirty tree, Yurucommu or other worktree edits.

The existing native smoke uses disposable ephemeral bindings. The operator
Core4.1.7/schema28 → current schema29 continuity probe checks D1/session/R2 but
neither asserts a KV value nor restores a closed snapshot. These are distinct
gaps. Add a current-artifact storage fixture to the checked-in native smoke:
real password login, public Note, media bytes and the Core's persisted origin
pin in native KV; close D1/KV/R2 before taking inventories and copying them;
verify every path/size/SHA before reopening the clone with the same artifact,
physical IDs, salt and encryption fixture. Do not reapply schema to the clone.
The original cookie, schema/data, public Note/media and KV value must survive.
Opening/restoring the clone must leave the original closed snapshot unchanged.

The fresh fixture's missing APP_URL exercises Core4.1.11's existing origin-pin
path using an HTTPS .invalid request. This is a test fixture, not an install
configuration change or a new public contract. Do not impose Yurucommu's
single-owner policy on Yurumeet. Never print cookies, private keys or raw store
values. Deny outbound Worker fetches locally. Remove only owned temporary
fixture directories. Keep existing smoke assertions and child/test deadlines.
The managed stdio helper bytes are copied from qualified Yurucommu #55;
shared packaging/API changes remain a principal proposal, not a product edit.

Filesystem regressions must reject missing files and same-size altered bytes,
with the native positive fixture proving actual Miniflare restore. Explicit fmt
and full read-only check precede handoff. Freeze canonical tracked/nonignored
source fingerprints and run all build/native/browser probes serially after a
fresh actual process scan; higher-priority Takoserver/Takosumi work wins.
Qualify local and actual CI checkout/artifact bytes separately. Preserve original
HEAD/status/binary diff and Yurucommu #55's clean source at return.

Native child results must finish within the unchanged 30-second deadline and
without a signal; partial markers never qualify a failed mutant. Bun can report
a timeout as exit143 without signalCode, so elapsed deadline refusal is explicit.
Real signal and timeout subprocess regressions retain this refusal. Positive
failures retain the child's stderr rather than only an exit-code assertion.
Each password lane, the required-salt qualifier and closed-store restore log
safe start/complete phase diagnostics to stderr. Completion is reported only
after that qualifier's cleanup resolves. These diagnostics improve failure
location evidence; they do not establish the cause of an earlier local timeout.

The copied operator extension retains old Worker fbe963…/Core4.1.7/schema28 and
its original artifact/proof identity. It is not a published-release predecessor.
Published v0.1.2 asset12dbf659…/lockedCore3.2.0 has a 19-migration source baseline
with same-name0019 divergence. Actual asset/schema provenance and an owning
reconciliation/compatible-schema policy, forward upgrade and restore remain
principal/Core dependencies. This current-artifact restart and operator-built
update evidence do not close published upgrade, live restore, Secret custody,
authentication integration/recovery, public lifecycle or full family GA.
No new permission/billing/resource, production deployment, real-data deletion,
merge/tag or package publication is part of this unit.
