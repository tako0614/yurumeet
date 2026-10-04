# Route-owned community actions and profile editing — 2026-10-04

Async community actions previously retained mutable page state across SPA
navigation. An unsent A settings draft remained open at B and could use B as
its save target. A committed A operation could then change B's title, member
rows, busy state or toast when its browser response eventually arrived.

Capture a route epoch and target ID when each operation starts, and invalidate
it on route change or cleanup, including A→B→A. Apply success, failure and
finally only to that lifetime. Community join/leave still refresh app-wide
contacts after a confirmed server result. Settings editors close on navigation,
retain their opening community, and submit a captured payload. Profile editors
retain the opening actor and submitted values; confirmed saves refresh the
root actor even after navigation, while the page-local callback is guarded.

The disposable native Worker/Chrome fixture uses one existing local owner
session, native community create/settings/profile/member APIs, cached remote
participants and accepted remote Follow edges. Remote participants are never
seeded as local owners. It checks an unsent settings draft across navigation,
held HTTP 200 settings/profile responses, and A's stale member-delete callback
while B's independent delete is still busy. Successful response status and bytes
come from workerd, are held unchanged, and match browser delivery. The SDK uses
bodyless successful assertOk for these operations; the fixture waits for fetch
settlement, a task and two frames before checking the DOM. Root actor refresh
is observed through the navigation profile link without a fixture refresh.

The five checks cover settings, profile save and member deletion success.
Join/leave, roles, requests, invites, late confirmation, failure and A→B→A
branches are source-fenced but do not receive focused native browser proof in
this slice. The root confirmation dialog does not expose cancellation; a late
confirmation is inert after route retirement, but its visible lifetime is a
separate scope. Profile follow/mute/block/report/message/copy-link and follow
list requests remain separate findings. The preexisting same-route request
retry race after a members-fetch failure also remains separate.

This is local source/runtime qualification, not an existing-data update or
public deployment. Core/API pins, schema and authentication policy are unchanged.
Yurucommu's single-human-owner product premise is not applied to Yurumeet.
Core publication/adoption, real issuer custody, existing-data update/restore,
public TLS/install/federation and native mobile remain distinct dependencies.
