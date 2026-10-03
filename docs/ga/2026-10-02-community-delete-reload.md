# Deleted outgoing bridges after tab reload — Yurumeet, 2026-10-02

Separate product unit after qualified #38 (`be7befb`). Control task TASK-0055
records the conditional browser client-format transition. Parent owns recovery,
UI, documentation and qualification; journal worker owns journal/source tests,
browser worker owns the new reload helper. Protect original message-search and
all receipt-bound prior files. No Yurucommu/Core changes or new Meet ownership
premise.

The current confirmed outgoing record survives denied sessionStorage removal.
Successful canonical community DELETE masks it only in memory; reloading loses
that mask and reconstructs the confirmed bridge from disk even when native
history has no object. The existing public recovery call-pattern regression is
red on #38: queue, confirm with removal denied, commit successful DELETE, create
a fresh recovery store using the same storage, merge empty history.

Keep version 1 outgoing intents unchanged. After canonical DELETE success,
attempt normal cleanup first. Replace each failed matching confirmed key with
minimal version 2 `{version, id, target, state: "deleted", serverId}` plus the
existing exact scope envelope. Verify bytes after write; do not guess deletion
from an empty history page, 404, message text or attachment resemblance.
Recognized markers seed exact origin/principal/target/server-ID suppression;
they never render or retry. Retire converted in-memory confirmed entries so a
later merge cannot remove the marker by its old key. Old v1 readers reject v2
and report restoration failure instead of displaying that bridge. Markers stay
for sessionStorage lifetime, with no TTL/LRU or automatic pruning.

This is conditional reload recovery. Full storage refusal, unreadable verification,
crash before persistence, already-mounted older clients, postcommit lost ACK and
durable quiescence remain separate concerns. Keep same-session masking and an
honest cleanup warning when durability is unproved. Do not require storage to
begin every DELETE or create an automatic resend/retry path.

Qualification requires meaningful storage/recovery tests, immutable #38 actual
Chrome/native-D1 red, candidate browser reload green with native object readback,
full owning gate, preserved 81-check browser prefix, exact-tree CI and independent
review. No source or local/CI success implies live GA, deployed installation,
existing-data upgrade/restore, real issuer/token custody, or federation/Queue/Cron.
No production deploy/publication, new resources/billing/auth permissions, live
D1 migration, real-data deletion, other-worktree edit or foreign process stop.
