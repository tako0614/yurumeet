# Serving Deployment and publisher target — 2026-10-01

Task: `GA-20261001-yurumeet-serving-deployment`.

Product/sequence: Yurumeet only after clean reviewed `cba57dde1994a29ce162161720e0d1ff3cb819c6`
/ PR #26. Product publisher and its regression tests/docs own this change.
Core/API/provider/schema/resource graph and runtime salt semantics are unchanged;
Yurucommu's single-owner premise is not imposed on Yurumeet. No other source
worktree or original uncommitted work is edited/staged.

This changes release behavior and target authority. The required evidence is
independent source review, old-source regression proof, focused actual-entrypoint
tests with isolated command mocks, full read-only `bun run check`, immutable
source/Worker digest correlation and exact-checkout-tree CI. This ledger, branch,
check or PR does not authorize a deployment. No live credential/provider access,
new permission/billing/resource, production deploy, schema/data mutation,
merge/tag/package publication or real-data deletion is performed.

Source gap: `versions list` is an inventory of deployable versions; its first
UUID is not serving-selection authority. The old query named `yurumeet` while
publication selected its name from the config. Account cache/environment and
child-side `.env` loading could also make the validated root target differ from
the effective target. Keep source findings separate from actual live incidents.

Acceptance:

- Preserve existing session-salt declaration/refusal and 0030 metadata guards.
  Before any gate/provider effect, admit only strict root name `yurumeet` and
  explicit canonical lowercase 32-hex account ID. Refuse a selected parent
  `CLOUDFLARE_ENV`, non-production `WRANGLER_API_ENVIRONMENT`, non-public
  `CLOUDFLARE_COMPLIANCE_REGION` or config `compliance_region`, and noncanonical
  Cloudflare API endpoint overrides without printing their values. Do not infer
  the account from environment/cache.
- Every Worker publisher Wrangler command uses the same absolute config and
  explicit zero-byte `scripts/worker-publish-empty.env.example`. Recheck that file
  before each call. This suppresses default `.env`/`.env.local` selection while
  preserving operator-supplied parent authentication or existing Wrangler auth.
  The name is explicit for status/publication/rollback; the admitted config fixes
  the account for D1/status/publication/rollback. No temporary-account flag is used.
- After clean-source capture and before gate/build, capture current Deployment
  JSON through installed Wrangler's status command. Require canonical UUID ID,
  strategy `percentage`, one or two unique UUID versions, numeric finite
  percentages 0.01–100 and a total within 0.001 of 100. Reject absent/malformed/
  unsupported deployment rather than fabricating a bootstrap rollback point.
- Retain the complete traffic map, including split/canary deployments. Read it
  again after the build/read-only D1 guard and immediately before publication.
  Refuse a changed deployment ID or normalized map; map order alone is not a
  change. Preserve exact config rereads and check the zero-byte env file again.
- Record `previousDeployment` plus exact rollback command/argv in result and
  post-touch failure diagnostics, replacing the misleading single `previousVersion`.
  Include every captured version/percentage and the same name/config/env-file.
  Do not automatically rollback/retry; preserve raw provider stdout/stderr and
  distinguish pre-publication refusal from indeterminate publication/post-smoke.
- Declare authority/independent review and actual provenance/reversal/failure
  behavior in `--contract`. A recheck is not compare-and-swap: the final race
  remains an operator serialization requirement. Do not claim it is eliminated.

Source facts were compared with installed Wrangler 4.107.0: explicit `--config`
bypasses redirect; absent `--temporary` clears temporary-account selection, then
root account_id precedes env/cache. Its global setup loads default dotenv before
environment selection unless an explicit env-file is provided. Commands remain
Wrangler-owned; no Yurucommu direct-API mechanism is copied.

Remaining GA conditions: actual public self-install/Plan-Apply-canonical State/
Output/launch URL and user journeys, live secret/key/salt custody and sealed
materializer preservation, actual OIDC/Takos re-authentication, physical portable
Host update/rollback/restore, deployed Queue/Cron/lifecycle/monitor, and shared
Core proposals for DM intent idempotency/pending Follow/unused upload cleanup.
First atomic OIDC owner claim remains Yuru-specific. Existing saltless instances
still need a separately reviewed first addition and re-authentication. Do not use
the stale live D1 migration ledger; the retained schema admission is 0030-only.

Primary references: [Deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/)
and [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
Validation will record source/local/mock/CI/live scope separately; a green gate
does not establish live rollbackability or a secret value.

The actual previous Deployment's resource bindings and Secret values remain
separate qualification requirements. The retained 0030 query admits the DB from
the realized config; this unit does not prove that it is the active predecessor's
physical DB or that publication preserves every non-code binding.
