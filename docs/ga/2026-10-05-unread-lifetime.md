# Unread state lifetime

Yurumeet owns its talk and notification badges separately. Each badge request
has its own generation so only the newest read for that channel can update the
count. A failed newest read leaves the last successful count in place and still
retires older pending reads. Badge counts are cleared and pending results retired
when origin, actor, local auth epoch, logout state, API transport, or resolved
endpoint changes.

Notification list reads capture the app context's origin, actor AP ID, auth
epoch, API transport, and resolved list/read endpoints. Both initial loading and
pagination check that scope after the list response and immediately before
mark-read; they check it again before applying a read acknowledgement. Page
cleanup retires the generation so a response after unmount cannot issue a
mark-read request. Follow-request and archive mutations reload the current
scope after acknowledgement, retiring list reads that began before the write so
they cannot restore a removed row. Same-scope focus reload waits while those
mutations are pending; scope changes still retire and reload immediately.

The deferred badge regression tests use independent channel promises and cover
out-of-order success, latest-read failure, independent channels, and scope
retirement. `bun test src/lib/badge-refresh.test.ts` is the focused command.
Browser evidence must separately verify rendered navigation badges and that a
retired notification page sends no mark-read request. Synthetic API tests do not
establish native, live-session, or production behavior.
