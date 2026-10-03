# Yurumeet timeline refresh and older-page race — 2026-10-02

Product-only unit after qualified #39/head70f5fae. The dedicated Yurumeet tree
owns feed state, App composition and browser qualification. Original
message-search changes, Yurucommu#67 and all earlier evidence stay protected.
No Core/API/schema/auth contract or Yurumeet ownership premise changes.

Source gap: an older-page GET captures the previous cursor, then a manual full
refresh replaces the head/cursor. The older GET can still append rows and
replace cursor/hasMore. Its failure/finalizer can also affect a newer operation.
Two overlapping full loads have the same problem. The immutable #39 Worker is
preserved separately before source edits; source inference is not runtime proof.

GA condition: starting a full refresh invalidates previous full/older requests.
Only the current request may commit rows, cursor, hasMore, freshness, error or
loading state. Older requests are allowed only after full loading ends, with
the exact current cursor. Preserve ordinary sequential paging, local row
patches, useful existing rows on refresh failure, and explicit retry. Component
disposal fences pending responses. This protects a mounted feed generation;
it does not introduce a server snapshot, cancellation, cross-tab deletion mask
or general principal/auth-epoch contract.

Acceptance needs deferred public-controller sequence regressions and actual
Chrome/native D1 old-artifact red/candidate green using a held real older-page
response followed by real refresh and the refreshed cursor's next request.
Controlled smaller native page sizes and manual-only observation, if used, are
explicit fixture conditions rather than default automatic-paging evidence.
Retain all previous86 browser checks. Complete the read-only owner gate and
exact-tree CI, distinguish local/synthetic/CI from public/live, and record
independent review before ready handoff. Heavy runtime/build jobs are serialized
after fresh launch scans; do not stop foreign processes.

Existing-data update/restore, divergent0019 policy, published tag/asset/schema
binding, real issuer/token/custody, deployed federation/Queue/Cron and exact
published app+Provider+Host installation/State/Output/URL remain separate GA
dependencies. No live D1 apply, deployment, publication, merge, new resources,
billing/auth permission, real-data deletion or other-worktree edits.
