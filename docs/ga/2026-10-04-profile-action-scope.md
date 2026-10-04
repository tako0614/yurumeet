# Profile action request lifetime

Profile actions capture the target and existing load generation/route epoch
before asynchronous work. Navigation, A→B→A, Reload and component cleanup
retire that window. Old message reads cannot select a contact or navigate the
new visit; old mute/block results and clipboard outcomes cannot change its
state or emit notifications. A successful block clears pending follow state
alongside the accepted follow state.

A block confirmation uses an optional AbortSignal owned by the current load.
Reload or cleanup resolves it false and dismisses its root dialog. Only the
same active dialog can settle; aborting an old signal cannot dismiss a newer
one. Already-aborted requests return false before replacing any live dialog.
All settlement paths remove the abort listener. The root logout's independent
authentication/authority checks continue to apply.

A report opening captures its Actor and a unique modal object. Rendering is
keyed to that opening. Submit targets the captured Actor; success, failure and
close require both the original profile window and modal object. An old A
request cannot close a newly opened B report or a reopened report for A.

The disposable native Worker/browser fixture holds real responses after D1
commit and compares browser/native response digests. The unchanged mainc1e3c648
Worker reproduced A's acknowledged mute changing B's menu to unmute and showing
A's success notification. The earlier Boolean-string oracle failure did not
qualify as product reproduction. The baseline also left A's confirmation
visible on B, let an acknowledged A report close B's report opening, and let
a settled local DM contact move B to the talk tab. These were separate native
response cases. Same-A report reopen and synthetic clipboard refusal are
additional candidate cases; the latter is labeled synthetic.

Complete owner/native/browser checks and exact-source PR CI must qualify this
candidate before merge. No generic Core or Yurumeet single-owner rule is added.
Packages remain published4.1.11. Existing operator-data update/restore (including
0.1.2/0019 lineage), real issuer custody, public environment, federation,
Provider/Host lifecycle and native mobile remain separate evidence.

Native artifact and browser qualification use Node.js 24.21.0, matching CI and
Miniflare's supported Node host. Bun continues to run the portable tests and
build. The prior canonical Bun1.3.14 run failed at MF-Op-Sync socket closure;
the exact upstream cause remains unproven. A same-Worker Node comparison with
global FormData failed the authenticated upload with HTTP400. The three native
multipart fixture owners now use Miniflare's public FormData constructor; the
same artifact passes all33 native predicates and password/synthetic-OIDC closed
restore. This adapts qualification fixtures, without changing product behavior,
package pins, credentials or schema. Final canonical browser and exact-source
CI qualification remain required; failed attempts stay retained.
