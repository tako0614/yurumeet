# Story creation outcome recovery — Yurumeet, 2026-10-03

This product-only change follows qualified Story snapshot PR #42. Shared
Core/API, database schema and ownership contracts remain unchanged. Yurucommu's
single human owner deployment premise does not define Yurumeet's ownership.

The Worker can commit a Story while its response fails to reach the browser.
The previous generic failure message enabled a new submission without explaining
that possibility. Keep the uploaded references and immutable click-time payload
in a tab-local sessionStorage record scoped to canonical origin, authenticated
principal and exact `/api/stories` endpoint. Verify ready and pending writes by
reading back exact bytes before the POST. Closing, reopening or reloading the
composer never sends automatically. A reloaded pending record is unconfirmed.
All create errors and mismatched acknowledgements remain unconfirmed; an HTTP
status alone does not prove that creation did not happen.

The recovery UI explains the unknown result, locks the editor, and requires
explicit duplicate-risk confirmation to resend the same payload and uploaded
references. Discarding the local recovery memo does not delete a public Story or
its uploaded media. Unreadable, corrupt or foreign storage fails closed; foreign
bytes are not overwritten. A failed ready write may be explicitly verified again
with the same payload before sending.

A strict SDK acknowledgement must identify a local Story by the expected author,
media reference/type, caption, overlays, display duration and coherent canonical
timestamps. Persist confirmed before removing the record. A received strict ACK
locks the live coordinator even if confirmation storage or cleanup fails. Hold
the exact-scope coordinator and its busy state for the page-module lifetime,
including same-tab auth unmount and principal re-entry. Detached views cannot
display another principal's result. A full page reload after a failed confirmed
write necessarily loses that in-memory certainty and hydrates the older pending
record as unknown; this change cannot provide exactly-once delivery.

At click time compare the active scope against the captured coordinator. Guard
again after reading file bytes, before SDK upload, and immediately before create:
the published SDK resolves its mutable transport synchronously at invocation.
Scope changes after upload retain references in the original scope and stop
Story creation. Successful creation closes/reset before best-effort refresh;
late completion cannot mutate a detached view. A remounted view can observe its
original operation's completion through its exact-scope subscription.
After an auth unmount, settlement clears retained editor metadata; an already
detached success callback does not close or refresh the replacement view. Its
Story bar uses ordinary refresh. A missing local memo alone is not a success
acknowledgement.

Qualification separates fixed-baseline real Worker lost-ACK reproduction,
portable coordinator tests, actual local Chrome with native D1/R2, the complete
portable gate and exact-tree CI. Keep the prior 103 ordered browser checks.
Local fixtures and synthetic browser failures do not qualify a deployed service.
Per-intent replay/authoritative lookup and reference-safe unused-upload collection
remain Core/API dependencies. Real issuer/token custody, legacy data update and
restore, immutable published identity, exact app+Provider+Host lifecycle and live
federation/Queue/Cron remain independent GA requirements. No live D1 apply,
publication, merge or production deploy is performed by this work.
