# Profile Follow request lifetime — 2026-10-04

Profile Follow, pending-request cancellation and Unfollow already captured the
target Actor, but their results, error toasts and busy cleanup were not scoped
to the visit. Navigation could leave a new profile disabled, and A→B→A could
apply the first visit's response to the later visit.

Capture the load generation and route epoch with the target, and guard every
success/error/finally outcome. Each reload retires old busy state. Preserve
accepted follower counts and pending cancellation. A retired request can still
commit on the server; the UI fence does not cancel its server operation.

Acceptance uses held real disposable Worker follow/unfollow responses, SPA
route changes, native relationship/counter readback, old-source red proof,
the complete owning gate, real Chrome and exact-source CI. Synthetic failures
are separately labeled. Fixture personas/cached participants do not establish
a product ownership policy; Yurucommu's single-owner rule is not imposed here.

Published Core/API4.1.11 Actor lookup lacks outgoing-pending hydration. Cold
reload cannot restore that state; publication and consumer adoption are separate
work. Actual existing-data update/closed restore, the v0.1.2/0019 lineage, real
issuer/token custody, public environment/lifecycle and native mobile proof remain
dependencies. Source/browser qualification does not prove those conditions.
