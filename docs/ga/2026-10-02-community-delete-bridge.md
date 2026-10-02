# Community DELETE and outgoing ACK bridges — Yurumeet, 2026-10-02

Separate product unit after #37/997f54b, in the existing dedicated Yurumeet
worktree. No Yurucommu/Core/schema changes or single-owner assumption added to
Meet. Preserve original message-search and immutable prior evidence.

A UI-sent M1 has a confirmed outgoing ACK bridge until later history has
observed its server ID. Optimistic deletion only removed the displayed row;
a concurrent M2 merge could reinsert M1 from that bridge. Immutable #37 pure
source reproduction is retained outside the repo; real-browser proof remains
required before qualification. The held pre-delete GET also contains a distinct
native-only M3 created through the authenticated API. M3 must remain absent
while held, then appear after that exact response is delivered while M1 remains
hidden. Later history GETs remain intercepted until this assertion completes,
so another poll cannot provide the consumption marker. Read M1's native object
row directly after successful DELETE; a missing audience JOIN alone does not
prove object deletion.

The recovery store tracks deletion operations by exact target and server ID,
within one principal's store. Pending and successful operations mask fetched
rows and confirmed bridges. A failure releases only its token and reports
whether any competing pending/committed mask still prevents restoration. A
success retains the same-session mask and retires all matching confirmed
journal entries. Capture the store before await and settle it even after
navigation; visible rollback/error remains fenced by the original conversation
generation, target and principal. Cleanup failure reports an honest warning,
keeps suppression in memory and retries cleanup on later merge.

No persistent deletion tombstone or new journal schema is introduced. After
successful cleanup the next reload obtains native history. If browser storage
refuses ACK/delete cleanup, a confirmed journal entry can remain and a reload
may temporarily reintroduce its bridge; same-session suppression does not
qualify durable recovery under storage failure. Mask lifetime is the recovery
store's session; do not expire it by TTL/LRU and resurrect late stale history.
The memory cost grows with deletions in a long-lived session. Authoritative
quiescence and durable cleanup policy are follow-up concerns. A lost ACK after
a committed server DELETE remains part of shared replay/reconciliation scope.

Acceptance: pure current call-pattern red, meaningful operation-lifecycle
regressions, immutable #37 real Chrome/native-D1 red with UI-sent M1/M2 and
history observation controlled, green pending/failed/successful deletion with
native readback and stale-window rejection; preserve old74 browser prefix.
The prior ABA test now verifies pending M1 stays hidden after re-entry, the stale
failure applies no snapshot/toast, then a fresh current poll restores native M1.
Run full owning `bun run check`, complete real browser suite, and exact commit
CI independently. Source/local/native/synthetic/CI do not establish live GA.
No deployment/publication/new cloud resources/billing/auth permission/live D1
apply/real-data deletion. Heavy local work waits for fresh vacancy; pure focused
unit tests can run independently and no foreign process is terminated.
