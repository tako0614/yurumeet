# Yurumeet bookmark removal and stable draft identity — 2026-10-03

Product UI unit stacked on PR44/head `c7ef25b81f1c178448f28663ab8b83769a814992`.
Only the dedicated Yurumeet worktree is edited. Original message-search work,
Yurucommu changes and prior qualification receipts are preserved. No Core/API,
schema, authority or ownership-model change is included.

Source gap: PostCard changes the bookmark flag, but BookmarksPage retains the
confirmed unbookmark's row. A later page response can also reintroduce a removed
row. Updating a Solid For item during a pending mutation replaces the card and
loses its local pending guard.

Acceptance: use two real saved posts in a disposable native Worker database.
Remove one through Chrome; the HTTP result, public bookmark list and native
actor/object-specific row removal must agree. The target disappears immediately
from Bookmarks, the unrelated bookmark stays, and both posts stay. Unbookmarking
from the ordinary timeline retains the post. A refused request retains the row
and flag and needs an explicit retry. A committed request whose response is lost
retains unconfirmed UI until a manual read-only refresh observes the list; no
automatic DELETE is issued. Refresh failure retains visible rows and guidance.
An in-flight bookmark request that settles after SPA logout must not dereference
the absent actor or publish a stale patch/toast. The regression uses a held,
nonforwarded DELETE503 after real logout; it certifies async UI cleanup, not a
successful bookmark mutation or a new session-generation contract.

The page owns pending IDs across card replacement. Confirmed removals fence
in-flight heads and the current cursor chain; only a successful later head
replaces that fence, allowing a later save to be observed. Component disposal
fences feed responses. These are mounted-page guarantees, not a durable mutation
journal, cross-tab coordination, server snapshot or session-generation identity.
The public SDK's void interaction ACK remains the consumed contract.

Qualification distinguishes controller tests, local native Chrome, CI and live.
Keep prior114 browser checks in order, run the complete owner gate and review the
candidate independently before returning a Ready PR. Launch heavy commands
sequentially after a fresh host scan; do not stop another session's processes.
Failed fixture runs stay recorded and are excluded from success evidence.

Observed PR44 baseline: real DELETE200, public list and native row agree that only
the selected bookmark is absent, both posts and the unrelated bookmark stay, but
the selected DOM card remains. The provisional candidate passed all seven Chrome
lanes (12 checks, 13 public fixture Notes, seven exact issued session rows and no
outbound requests); the final source additionally needs the auth-loss regression,
complete owner gate, canonical prior114 prefix and exact-head CI. Qualification
receipts and final counts are returned separately in the integration handoff.

Canonical qualification also exposed an existing draft lifecycle defect before
the new bookmark lanes: the visible failed-read warning changed to `conflict`.
The conversation selector/profile dependencies can update without changing the
scoped identity, but the previous effect still called save/enter and cleared
attachments/search. Memoizing the scoped identity confines those transitions to
an actual owner/origin/conversation change. The existing exact read-error check
is retained and extended with same-contact reselection, unchanged saved bytes
and empty unconfirmed input. No failure is accepted as a successful recovery.
The exact dependency scheduling that triggered the original failure is unproved;
the recorded warning status and source lifecycle path are distinct evidence.

Existing operator-data upgrade/restore, real issuer/token custody, immutable
published app + Provider + Host Plan/Apply/State/Output/URL, deployment recovery,
live federation/Queue/Cron and shared session/replay contracts remain separate.
No deploy, publication, live D1 apply, new billing/permissions/resources, merge,
real-data deletion or other-worktree edits are authorized by this change.
