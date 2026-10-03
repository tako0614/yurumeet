# Story submission snapshot — Yurumeet, 2026-10-02

Product-owned unit after qualified #41 (`0b7c24b`). Preserve the original
message-search differences, the independent Yurucommu worktree and previous
frozen evidence. Shared Core/API/schema/auth/ownership contracts do not change.
Yurucommu's one-human-owner premise does not define Yurumeet's ownership model.

The Story composer selected its file before awaiting media upload, but read its
caption afterwards. Editing the caption during that wait could combine file A
with caption B. Capture the file, trimmed caption and display duration before
upload starts. The rendered form calls the same submission coordinator as the
deferred-upload tests. Upload-provided references supply the attachment; they
do not replace the captured editor metadata.

During upload and Story creation, disable file, caption, submit and dismissal
controls and guard their handlers synchronously. Keep an accessible progress
status focused inside the existing dialog's Tab/Escape boundary. A failure
preserves the file and caption, re-enables the controls and restores the prior
connected, enabled control's focus while the modal remains open. A confirmed
creation resets/closes the form before a best-effort Story-bar refresh; refresh
failure must not present the committed creation as failed. Unmount fences late
local state, focus, close and callback effects; it does not cancel remote work.

Qualification requires a fixed #41 Worker in actual Chrome with a real media
upload response held after completion: edit A to B, release unchanged bytes,
and observe B in the actual Story POST and native stored Story. The candidate
must instead keep the click-time draft, fence controls during both upload and
creation, preserve keyboard focus, and produce one Story/Create with matching
native R2 bytes. An upload aborted before forwarding must produce no Story or
Create, preserve the draft/focus and permit one explicit coherent retry.
Retain the prior 92 ordered browser checks, run the owner's complete read-only
gate, qualify the exact CI tree and obtain independent review before handoff.
Serialize test/build/native/browser launches after a fresh process scan.

This unit does not qualify a rejected creation as safe to retry: the POST may
already have committed. Lost-ACK recovery, per-intent replay and reference-safe
unused-media cleanup need separate shared contracts and proof. General auth
epochs, published identity, existing-data update/rollback/closed restore, real
issuer/token custody, deployed federation/Queue/Cron and exact published
app+Provider+Host installation remain separate GA conditions. Fixture schema
success does not repair the stale live D1 migration ledger. No live D1 apply,
publication/tag/merge/deploy, new resources/billing/auth permissions, real-data
deletion or edits to other worktrees are part of this unit.
