# Yurumeet code-only publisher — 2026-10-01

Scope: Yurumeet product worktree only. Parent owns deploy entrypoint, schema
validator, package/contract/docs. Separate workers own the provider's three new
files and existing entrypoint fixture test. Original message-search work, Yurucommu,
Core, control and other worktrees are read-only. No Yurucommu ownership premise
is applied to Yurumeet. Integration order: existing #24 → #25 → #26 → #27 → this PR.

The old normal Wrangler deploy reconstructed bindings, inherited Secrets from
latest without a predecessor ID, retried ambiguous upload errors and could patch
settings/consumers/triggers. This unit reads existing Wrangler authentication in
pipes and uses fixed Cloudflare APIs. No credentials/grants/resources are created.
Only one fixed readonly D1 query, one Version upload and one Deployment promotion
are allowed. Unknown/malformed metadata, config drift and split traffic refuse
before publication. Every actual binding inherits from the exact 100% serving
predecessor. Hidden Secret equality is not claimed.

Code proof uses version-specific content/v2?version=UUID as implemented by pinned
Wrangler 4.107.0, strict single worker.mjs multipart content and its raw SHA256.
Version etag is opaque; an undocumented hash algorithm is not assumed. Complete
Version binding/runtime closure and Worker settings must remain equal. Readbacks
are not CAS; operator serialization is still required. Manual recovery prints a
Deployment API request with the full prior map, never a settings-changing CLI
rollback. Failure phases retain the latest attempted write; no retry or auto-repair.

Authority-trigger independent review covers exact source, fixed endpoint/account,
Secret inheritance, code/non-code proof, no auxiliary mutations, bounded masked
diagnostics, lost acknowledgements and source/CI provenance. Full bun run check
is required before handoff. Source/mock/native/local browser/CI/live evidence must
retain separate artifacts and identities. Unchanged runtime bytes may reuse a
previous browser qualification with its original source identity.

No production deploy, live D1 mutation, migrations apply, permission/billing change,
real-data deletion, merge/tag or immutable publication is authorized by this unit.
Public API behavior/permission scope, hidden Secret custody, encrypted OAuth and
OIDC continuity, live rollback, public install/lifecycle and platform materializer
preservation remain separate dependencies. Native code rollback and closed Meet
snapshot restoration are not qualified by publisher mocks.

Primary API contracts: [Version upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/),
[Deployment create](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/),
[D1 query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
Version-specific content query details are from installed official Wrangler source,
not a live call or a documented guarantee of the public content endpoint.
