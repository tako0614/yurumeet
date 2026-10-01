# Synthetic OIDC credential restore — 2026-10-01

Task: `GA-20261001-yurumeet-oidc-storage-restore`.

Scope: Yurumeet only, stacked after qualified #30 `7a96dfe`. Parent owns the
existing native restore module/declaration, smoke integration/tests, product
documentation and qualification. A bounded worker owns only the local synthetic
issuer helper/declaration. No Core, Yurucommu, control, original dirty tree or
other worktree edits. No real credential, permission, billing, resource, deploy,
publication or real-data mutation. Authentication proof requires independent
review. This fixture does not impose Yurucommu's product ownership premise.

The existing current-artifact restore uses password sessions with null provider
tokens. Add an OIDC case using the same full closed D1/KV/R2 byte clone, current
artifact, IDs, salt and key. A local ES256 issuer admits only exact synthetic
endpoints; actual browser authorization-code PKCE/nonce/JWKS HTTP creates its
fixture identity/session. Keep APP_URL absent to exercise the real canonical
origin KV pin already qualified by the password fixture. Do not seed identities
or sessions with SQL. The password restore and all existing assertions remain.

Acceptance: all selected SQL rows/schema and original protected stores unchanged
at restore; original cookie and provider presence survive; encrypted access and
refresh fields match byte-for-byte and independently decrypt to exact issued
fixture values; wrong key and tampered ciphertext reject. Native Note/media/KV
must survive. On the restored clone, same-subject OIDC reauthentication rotates
the session and keeps every existing fixture actor/data field except Core's
legitimate login `updated_at`, which must be a valid, monotonic timestamp bounded
by that actual login. Full pre-reauth restore equality includes that timestamp.
Logout rejects the
new cookie and removes its persisted salted row without changing product data;
a further same-subject login recovers the fixture. No plaintext key/token/cookie
is printed: OIDC runtime output is discarded with only a bounded byte count,
and unexpected runtime/cleanup failures use fixed safe labels. The OIDC `/me`
response checks identity and provider presence together to retain headroom in
Core's copied authentication rate-limit bucket. All owned runtimes and temporary
stores finish cleanup before success.

This is same-current-artifact restart/restore, not immutable v0.1.2 upgrade.
That old release uses a distinct locked Core3.2.0/19-migration baseline, with
same-name0019 divergence awaiting principal/Core reconciliation. Current Core's
provider token fields are write-only; independent AES-GCM recovery proves stored
ciphertext recoverability, not actual Takos token use/refresh. Real OIDC/Takos,
public custody/materializer preservation and public/live lifecycle remain open.

Checks: parse-only `node --check`, explicit `bun run fmt`, focused native positive
proof and meaningful result acceptance controls; full read-only `bun run check`
once on frozen source; fresh CI native and browser proof. Keep existing native
child deadlines. Run heavy local gates serially after fresh /proc inspection,
yielding to higher-priority platform work. Exact unchanged product Worker bytes
may reuse #30 local browser evidence retaining its original source identity.
