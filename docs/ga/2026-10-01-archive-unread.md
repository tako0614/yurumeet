# Restore archived unread conversation badge — 2026-10-01

Task: `GA-20261001-meet-archive-unread`, Yurumeet only, after #31.
Parallel family auth-method recovery remains in its Yurucommu assigned worktree
and independent PR. Bounded worker owns only `src/App.tsx` and
`scripts/release-browser-talk.mjs`; parent owns this ledger and qualification.
Preserve original dirty message-search source/test and all existing product
checks. No Core, control, other worktree, resource, permission, billing, deploy
or real-data operation. Do not infer Yurucommu's ownership model for Yurumeet.

Source gap: the archived-list restore button removes archive state and refreshes
contacts but omits badge refresh. Actual Core unread count excludes archived
contacts; navigation can stay stale until its20-second visible-page polling.
Nearby archive/undo/open-archived paths already explicitly refresh badges.

Add an actual native/browser unread conversation journey to the existing talk
verifier; run it against immutable #31 Worker before the UI fix. Observe
persisted unread/archived/contact state and navigation badge, restore through
the actual archived-list button, and require prompt authoritative badge update
before polling can supply success. Do not seed a successful UI response or mark
a read message unread merely to satisfy the verifier. Parent runs runtime/
browser/build only, serially after fresh `/proc` inspection. Fix only the
existing restore handler after red evidence, then qualify full frozen-source
owner check and fresh local/CI browser on digest-identified Worker bytes.

Public DM/federation, live lifecycle, real credentials and published-v0.1.2
upgrade remain separate. A badge correction does not close per-intent delivery
idempotency, unused-upload cleanup or shared follow-state contract proposals.

Excluded fixture attempts: the initial missing mobile back control and unread
readiness failures do not establish a product defect. The fourth old-artifact
probe shows durable unarchive but native count0: at desktop width, loading the
thread auto-selects and legitimately marks its Note read (ChatContext's selected
thread contract). The corrected verifier archives an already-opened/read thread,
then inserts one new synthetic inbound Note newer than its persisted read marker
while archived. This is explicit local D1 fixture input, not remote federation
delivery. Qualify count0 while archived, then count1/contact restoration and
nav display immediately after restore, before the20-second badge poll.

Actual corrected old-control at20:46 UTC qualifies the intended red:3.37s after
restore, native total/dm1, archiveRows0, active contacts unread1, but Talk nav
has no badge. The archived view correctly has no active contact DOM yet. Add
one existing app.refreshBadges() call to the archived-list restore success
handler. Controlled CI36922728012 had full266/0/1607 and native33 on the exact
oldfd9 bytes, but its browser failed at initial readiness; that is excluded from
product regression evidence. The readiness waiter now starts before navigation
and awaits the actual200 unread response. New full/browser/CI remain required.
