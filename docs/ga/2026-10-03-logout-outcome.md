# Yurumeet sign-out recovery — TASK0059

Qualified PR43's immutable Worker reproduces a refused Settings logout in actual
Chrome149: one nonforwarded503, document reload and authenticated return without
an actionable error; old Cookie auth/me200 and the complete native salted session
row hash remain unchanged. This is a disposable password-fixture reproduction,
not a production incident. Existing browser110 did not cover sign-out controls.

Settings and Profile now use one root-owned confirmation and authentication
controller. OIDC auto-start suppression precedes asynchronous push cleanup.
Cleanup is best effort and bounded at five seconds. A captured-origin cookie
request sends one logout POST, inspects non2xx, and always follows with one strict
read-only current-user observation. The fifteen-second request deadline includes
the response body. Only401 from the actual current-user route establishes an
anonymous browser;403,429, outages, invalid JSON and malformed200 remain unknown.

Confirmed anonymous renders SignedOut without reloading. Same observed principal
keeps a persistent localized error and explicit logout retry across Settings /
Profile navigation and ordinary same-principal refresh. Changed/unavailable
principal hides the stale shell and requires manual recheck. POST never retries
automatically. A manual read that restores the captured principal also restores
the explicit logout retry; anonymous/new-principal observations clear that marker.
Root generation/tickets fence old auth results and superseded
logout, and captured origin does not acquire credentials from another SDK
transport. Ordinary refresh retains the provider and confirmation; identity
changes unmount scoped chat/editor state before a manual read exposes a new one.
Initial/server-connect unknown state cannot trigger OIDC before strict401.

An AP actor identity is an observed principal, not a HttpOnly session generation.
Push cleanup receives an abort signal on timeout/root reconfiguration/disposal.
Guarded public SDK runtime continuations refuse later subscription/storage
mutations after abort; root push rebind uses the same local-lifetime fence.
An already-started server unregister/unsubscribe cannot be retracted. A different
tab changing the cookie within the active cleanup window remains unqualified,
as does actual browser push delivery: logout browser fixtures block service workers.
The delayed runtime tests cover local aborts, not cross-tab principal identification.
Existing
Core4.1.11 can conceal durable delete failure behind200/Cookie clearing. Browser
anonymous state therefore does not certify durable revocation of an old cookie.
The shared producer gap remains a separate primary/Core owner proposal.

Meaningful controller races, strict transport/status/body-timeout tests, both
real UI callers, real committed logout with browser-only lost response, complete
owner gate, exact-tree CI and independent review are required before qualification.
Preserve all110 preceding ordered browser checks and failed runs. Every test /
build / native / Chrome run requires a fresh heavy scan and serialization.

Yurucommu's personal single-human-owner premise is not applied to Yurumeet. Shared
Core/API, schema and permissions remain unchanged. Disposable native fixtures /
synthetic failure / Chrome / CI do not prove real issuer/custody/refresh, existing
operator-data update/restore, immutable v0.1.2 release reconciliation, exact
published app+Provider+Host installation/lifecycle, or deployed federation /
Queue / Cron. No merge, tag, publication, deploy, live D1 apply, new resources /
billing / authentication permissions, real-data deletion or other-worktree edits.
Current candidate validation is recorded in the operator handoff, not inferred
from this design document. Family GA remains active.
