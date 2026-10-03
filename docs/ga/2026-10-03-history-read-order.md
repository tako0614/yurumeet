# Yurumeet full history and newest-page poll ordering — 2026-10-03

Product-only unit after PR45/head `32c234e30a0beb717c46dac96164ec2d44c63c73`.
Work stays in the existing dedicated Yurumeet worktree. Original message-search
changes, Yurucommu PR74 and previous frozen qualification receipts are preserved.
No Core/API/schema/authority or Yurumeet ownership premise changes.

Source gap: a full history read and the four-second newest-page poll run
independently. A successful poll can receive a new message while the earlier
full read is still pending. That full read can later replace the messages with
an older snapshot or set an error that hides the confirmed messages. A poll
started before a full retry also lacks that retry's generation fence.

Acceptance: a valid poll begun after a pending full read may establish usable
history, paging, read receipts and loading/error state. The obsolete full
success, failure and finalizer cannot undo it. A poll begun before a newer full
read, conversation change, principal change or disposal cannot affect that
generation's history, error, paging, receipts, typing or connection state. Keep
poll recovery of a failed full read, ordinary full-first/poll-later ordering,
older history, outgoing recovery/deletion masks and explicit retry. Do not
disable polls until a full read settles or automatically resend a mutation.

The product read coordinator executes the asynchronous full/poll ownership
decision used by the real call sites. Deferred regression tests cover the
response orders and invalidation. Real Chrome/local native D1 qualification
must use the same fixture with the frozen PR45 Worker and candidate, holding
actual GET bytes and obtaining later history through the public API. Deliberate
nonforwarded GET503 is failure injection, not a successful native response.
Keep all prior127 full-browser checks in order and append the new checks.

Run the complete owner gate, source/artifact checks, independent source/oracle
review and exact-tree CI before Ready handoff. Serialize heavy native/browser/
build work after a fresh launch scan; do not stop foreign processes. Retain
failed attempts without including them in successful qualification evidence.

This is a mounted product read-order guarantee. It does not establish durable
session generation, cross-tab coordination, server snapshot consistency, real
operator-data update/restore, issuer/token custody, published app/Provider/Host
installation, public TLS, live federation/Queue/Cron or GA readiness. No merge,
publication, deploy, live D1 apply, new billing/auth permissions/cloud resources,
real-data deletion or other-worktree edits are part of this change.
