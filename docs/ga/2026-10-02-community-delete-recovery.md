# Community DELETE recovery — Yurumeet, 2026-10-02

Product-only unit stacked on #36/48cdd4d. The owning dedicated worktree is
`/root/hdd/takos-dev/worktrees/yurumeet-ga-20260930-1737`. Protect original
message-search changes, the qualified #36 receipt and Yurucommu work. Do not
change Core/schema/auth permissions or extend Yurucommu's single-owner product
premise to Yurumeet.

Gap: failed optimistic community DELETE restored a captured entire message
array. A new native POST/poll arriving during DELETE was persisted but hidden
when that old array replaced the current list. A switch A→B→A could receive the
same stale rollback and error toast because contact identity alone did not
identify the mounted load generation.

Change: restore only the removed row from the snapshot into the current list,
without duplicating a row reloaded meanwhile. Insert by canonical ascending
`(created_at,id)` as returned by the Core community endpoint; leave existing
rows in their current order. Capture generation, community type/AP-ID and
principal before removal; apply restoration and its error toast only while all
still match. This does not change the server DELETE or shared replay contract.

Acceptance: immutable #36 actual Chrome/native Worker red must show a real
persisted M2 disappear after the held failed DELETE. A separate A→B→A red must
show the stale snapshot and obsolete error. Green independently retains M1/M2
on the current view and, after A→B→A, leaves newly loaded rows untouched and
shows no obsolete error. Native readback confirms both objects remain. These
fixtures deliberately abort DELETE before Worker/Core, while community
creation and POST/poll use the real local Worker. They qualify that known
pre-Core failure; a lost acknowledgement after a committed DELETE can still
briefly restore a row until later polling and remains outside this proof.

Focused helper regression covers concurrent rows between snapshot neighbors,
already-restored rows, reload placement and ID tie ordering. Run the owning
`bun run check` and complete browser suite (preserve the prior72 prefix and add
these two checks), then qualify the exact committed tree and CI. Record final
results/hashes separately in the integration return. Serialize heavy launches
after fresh occupancy checks; a scan is not a reservation. No foreign-process
termination, deployment/publication, new resources/billing, live D1 apply or
real-data deletion is authorized by this unit. Full family GA remains open.
