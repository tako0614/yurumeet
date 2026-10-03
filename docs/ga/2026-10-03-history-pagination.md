# Yurumeet history pagination order — 2026-10-03

Core orders DM and community history by `(published, ap_id)` and accepts that
tuple as the older-page cursor. Meet selects the first displayed canonical row
for the cursor, but its outgoing recovery merge used locale collation. For
same-millisecond IDs such as `/A`, `/B`, `/a`, and `/b`, that can leave `/a` first
after the older `/A`, `/B` page arrives. The next request repeats that page and
can leave still older messages unreachable.

Meet now compares timestamps and IDs with the same relational comparisons used
by its fetched-window reconciliation. This preserves the native tuple order for
serialized ASCII URL IDs, while retaining pending/failed rows, ACK bridges,
deduplication, and the existing history generation fences. Core/API, schema,
authentication, and the original message-search work are unchanged.

Two recovery regression cases cover the canonical page boundary and a mixed
ACK/pending/failed list. The native Chrome fixture opens DM and community history
with 105 messages each, checks two same-millisecond boundaries, uses the older
button and near-top scroll, and checks native cursor/IDs/has_more, exact DOM
order/uniqueness, viewport compensation, and no further older request after the
last page. Fixture rows are synthetic in disposable local D1; successful GET
bytes come from the actual Worker. A native SQL ordering query is the oracle.
Paging may send its intentional read receipt, but actor/session/message and
recipient/activity/community/member rows must stay unchanged after setup.

PR46's frozen Worker fails the first DM display-order assertion in actual
Chrome. The portable regression is red with 30 passing and 2 failing cases;
after the product fix, the new cases and adjacent recovery/history tests pass
(61 cases, 315 assertions). Complete gate and candidate browser/CI evidence are
recorded separately in the integration handoff once completed.

This is product-local pagination evidence. It does not establish actual
operator data update/restore, real OIDC issuer custody, published app/Provider/
Host lifecycle, public TLS, live federation/Queue/Cron, or GA readiness. Raw
non-ASCII IRI comparison parity with SQLite BINARY is outside the ASCII URL
regression; the existing relational reconciliation has the same boundary.
Conversation-switch scroll completion is a separate unverified source risk.
Yurucommu's single-human-owner premise is not applied to Yurumeet.
