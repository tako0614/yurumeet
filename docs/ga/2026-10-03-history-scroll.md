# Older-history scroll ownership — 2026-10-03

An older-page request can finish after the reader switches conversations.
The provider correctly discards the stale messages, but ChatPane previously
still queued a height-based correction using the previous conversation's
scroll metrics. In actual local Chrome, releasing a successful native older
GET after switching to a taller thread moved that thread from 430px to 8860px.

Older reads now return an application ticket only when new canonical rows
survive the outgoing-recovery merge. Failures, discarded responses, and
duplicate or masked-only pages do not authorize a scroll correction. A valid
page still updates its has-more flag. The ticket retains the history generation,
conversation and principal checks for the later animation frame. The pane also
checks its connected scroll element, cancels owned frames on scope change or
cleanup, and keeps a latch through the frame so another older load cannot
reuse uncompensated metrics. An old completion cannot release a newer latch.

Portable tests exercise the actual coordinator and scroll controller together:
normal growth, stale success, reload between application and frame, switching
away and back, disconnect/replacement/cleanup, failure/no prepend, and the
pending-load latch. Existing recovery and native pagination tests cover normal
button and near-top paging, deduplication and deletion masks.

The native Chrome fixture uses two communities with 51 and 50 messages, real
POST openers and disposable D1 seeds. It holds actual Worker GET bytes, switches
through the UI, then checks the destination's message count, anchor and scroll
position after the application consumes the old response. Actor/session/message,
recipient/activity/community/member rows must stay unchanged after setup; the
only permitted additional mutation is the selected rooms' read POST. This is
local evidence, not a live deployment or an existing operator-data update.

Separate source findings remain open: an empty poll retains deleted canonical
rows, and the installed DM SDK maps non-2xx JSON without messages to an empty
terminal page. Community SDK checks status but defaults missing messages too.
Destructive empty reconciliation requires status/shape-authoritative shared
reads plus pending/failed/post-start ACK protection. No native red was run for
those findings, and no Core/API change was made here. Height growth from a
same-generation poll/send is outside this scope. Raw non-ASCII IRI ordering,
real issuer custody, published install lifecycle, public TLS, federation,
restore/monitoring and native mobile are separate evidence. Yurucommu's
single-human-owner premise is not applied to Yurumeet.
