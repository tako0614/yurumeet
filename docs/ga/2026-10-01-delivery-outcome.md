# Unconfirmed message delivery — 2026-10-01

Task GA-20261001-yurumeet-delivery-outcome, after talk/media PR#22. This unit
changes only Yurumeet presentation and its source/native-browser validation.
The parent owns this ledger, README translations and integration evidence;
the UI worker owns ChatPane/chat-context/message-delivery files; the browser
worker owns release-browser-talk.mjs. Original message-search work is protected.
No Core/API/schema/published pin, deploy mechanism or data migration changes.

## Problem and product behavior

With published Core/API4.1.7, a real local DM POST can commit and return201 while
the browser loses that response. The old UI calls this an unsent message; its
manual retry creates another Note/Create/recipient/peer-inbox row. The operator
reproduction also sees two persisted bubbles after reload. This is native local
workerd/Chrome evidence, not a production incident or external delivery proof.

Received client-error responses and unconfirmed outcomes now have separate
local states. Transport, timeout, successful-response parsing, server errors
and unknown exceptions cannot prove absence of a commit. Their bubble and
toast say the result cannot be confirmed. The bubble advises checking history
and explains that sending again can duplicate the message. Manual retry stays
available. Hiding an unconfirmed placeholder is labeled as hiding its display;
it does not claim to delete a potentially saved server message. No automatic
retry or content-based deduplication is introduced.

## Required verification

The complete read-only repository gate and exact committed CI must qualify this
unit. Focused tests use the actual published ApiError class and cover received
4xx,408/5xx, transport/abort/parse errors and lookalike/unknown errors. Browser
validation retains contact/text/media/private-readback/mobile checks and the
before-HTTP-abort retry case. A separate real backend201 then dropped-response
case checks the uncertainty copy and preserved database effects before and
after hiding the placeholder, then reloads the saved server message. A received
backend rejection is checked independently if exercised; it is not a success
stub. External-origin blocking and cleanup remain required.

Evidence is retained outside the repository in operator-runs/
yurumeet-ga-delivery-outcome-20261001. Source fingerprints, actual artifact and
schema digests, native/browser results, source review, protected originals and
terminal exact-source CI are returned together in the integration handoff.

## Remaining dependencies

This unit cannot prevent duplicate sends after an unknown outcome. Principal/
Core/API proposal: yuru-family-dm-idempotency-core-proposal-20261001.md in the
integration handoffs directory. A stable client operation identity and atomic
replay contract must be published and qualified in each exact consumer. Equal
content from separate intentional sends remains valid. Existing data is not
guessed, rewritten or removed.

Other requirements retain their separate owners and evidence: abandoned upload
lifecycle; Yurucommu-only atomic first-owner claim; exact published app/Provider/
Host installation; actual external Follow/Queue/Cron; OIDC/native/public TLS;
update/Destroy/rollback/restore/monitor and salt/key/data continuity. This unit
does not impose a single-owner premise on Yurumeet or open its managed CTA.
Never improvise migrations apply against the stale live D1 ledger.
