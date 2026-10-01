# Enforced runtime and realized-config session salt — 2026-10-01

Task: `GA-20261001-yurumeet-session-salt-runtime`.

Product/sequence: Yurumeet only, after reviewed clean `87e911b450d35e8fb32591cb7754ec996f644567`
/ PR #25. Separate from Yurucommu #53; shared required binding name and accepted
byte semantics agree, but the Yurucommu single-owner premise is not applied to
Yurumeet. Shared Core/API 4.1.11 and Provider pins/schema are unchanged.

Ownership: product binding composition, code-publish entrypoint/config admission,
scoped source/native acceptance and operator docs. Authentication enforcement and
release behavior require independent source review, the complete read-only owner
gate and exact-tree CI evidence. Worker and immutable Worker-release surfaces
declare authority/independent review; published identity retains create-only
no-overwrite. No deploy authorization follows from any of those records.
No Core/control/Yurucommu/original/other-worktree edit, live credential access,
new auth method/permission/billing/cloud resource/deploy/publication/real-data
deletion is performed.

Acceptance: both declared lanes reject absent/non-string/trim-blank/exact public
development salt before Core effects for fetch/queue/scheduled, preserve invalid-
lane error precedence and every accepted salt byte. Format/presence is not
entropy qualification. Regressions on the old source must demonstrate the gap.

The code-only publisher must refuse an exact realized strict JSON root config
without the salt name exactly once in `secrets.required`, malformed/duplicate
declarations, plaintext `vars` conflicts and environment-only declarations,
before gate/build/D1/version/publish effects. Existing config-stability and
0030 metadata admission remain. Password and OIDC-only config fixtures both
reach the existing inherited-secret publishing path, without requiring password
on the OIDC-only path. The guard never reads/generates/rotates a Secret value.

The checked-in config is a local development template. A blanket salt-only
`secrets.required` would suppress other local authentication/encryption inputs;
making password universally required would break OIDC-only deployments. The
operator's publication config declares all secrets its chosen auth method uses.
This task checks the salt declaration and Wrangler's inherited-required binding
behavior; it does not prove actual secret value, active predecessor selection,
public account/token permissions or provider lifecycle. Named environment
selection remains unsupported and refused rather than guessed.

Native artifact acceptance uses fresh disposable Cloudflare D1/KV/R2 stores,
checked schema only and real HTTP password login: valid salt control, three
invalid salt refusals with the fixed guard marker and no actor/session writes.
No identity/session seed or Yuru owner-model assertion is introduced by these
guard fixtures. Portable invocation behavior is separate generated-entry proof,
not a physical portable Host install/update claim. Existing native queue/cron/
post/media/password/revocation journeys retain their assertions.

Existing instances using Core's fallback require separate credential-owner-
reviewed first Secret addition and password/OIDC re-authentication, preserving
encryption key/data and the chosen salt through updates/code rollback. This task
does not run that operation, transform/delete sessions, inspect private configs,
or qualify the sealed materializer's existing-secret preservation.

Remaining conditions: actual OIDC/Takos recovery, public self-install canonical
State/Output/launch URL, live secret custody, public DNS/TLS peers, deployed
Queue/Cron/lifecycle/monitor and platform update/Destroy/rollback/restore proof.
The current version-list-derived publisher reversal point requires independent
active-deployment scrutiny; a Version list is not serving-selection authority.
Shared DM idempotency, pending-Follow hydration and reference-safe unused-upload
cleanup proposals stay with principal/Core. Never apply migrations through the
stale live D1 ledger; the retained metadata guard qualifies migration 0030 only.

References: [required secrets and local input selection](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets)
and [deployed Worker secret validation](https://developers.cloudflare.com/workers/configuration/secrets/#validate-secrets-before-deploy).
Current docs plus installed Wrangler 4.107.0 source/schema were compared;
latest Workers types 5.20261001.1 were retrieved as operator-only references,
with no dependency/lock change. Source/local/CI/live evidence remain distinct.
