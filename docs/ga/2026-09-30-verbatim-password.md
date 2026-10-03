# Verbatim browser password — 2026-09-30

Task: `GA-20260930-yurumeet-verbatim-password`.

Scope/order: Yurumeet only, in its assigned worktree, stacked after #17.
Parent owns AuthScreens.tsx and this task ledger. Preserve original
message-search work; Yurucommu and shared Core remain unchanged. Reproduce
against the existing native artifact, fix the UI, independently review, run the
complete owner gate with an empty heavy-check slot, verify the newly built
artifact through actual Chromium, and return exact-head CI and dependencies.

The locked published Core 4.1.7 password route intentionally treats every
nonempty password as an opaque credential. The browser UI trimmed the input
before sending it, preventing a valid password with leading/trailing whitespace
from logging in. Its submit condition also disabled a whitespace-only password,
even when configured as a valid PBKDF2 credential. The UI now sends the exact
input and rejects only an empty string. Core still decides which credentials
are valid; no authentication method, permission or stored credential changes.

Before editing, disposable HTTPS Miniflare and actual Chromium confirmed that
the literal API credential succeeds for all three fixtures. The original UI
sent a changed surrounding-whitespace password and got 401, disabled the
whitespace-only fixture, and successfully logged in with the ordinary control.
Both API and UI used real published Core routes and native D1/KV; no auth API
responses were mocked. The existing fixture owner avoids provisioning claims.

After the fix, require all three raw inputs to produce successful login, secure
HttpOnly SameSite=Strict cookies inaccessible through document.cookie, matching
owner readback and one salted SQL session, and an authenticated view after
reload. Empty input stays disabled. Local self-signed TLS is accepted only in
the isolated browser context; this does not qualify public TLS or deployment.

Browser evidence and the replayable operator script are outside the repository
under `/root/hdd/takos-dev/operator-runs/yuru-family-ga-browser-password-20260930/`.
The script uses the already installed Yurucommu playwright-core 1.55.1; no
Yurumeet dependency or lockfile is changed. Its initial Bun HTTPS setup failure
is excluded from regression evidence; Node executes the successful browser
qualification. The complete portable owner gate and exact-head CI are separate.

This unit does not qualify OIDC, mobile/native bearer clients, first-owner
provisioning, real remote federation, managed installation, lifecycle, restore
or alert delivery. Terraform bootstrap-token normalization and E2E environment
password normalization are distinct follow-up candidates, not fixed here. No
production deploy, new billing/authentication rights, real credential rotation,
schema mutation or destructive real-data operation is performed.

Local complete gate: Bun 1.3.14 / OpenTofu 1.12.3, 209 passed / 0 failed
and 6 mock-provider plan tests passed. It started with no global full-check
process and all tracked/new source hashes matched before/after. This result
paragraph is the only source addition afterward. Independent read-only review
is complete, including stronger authenticated-shell and owner checks after
browser reload. Browser qualification of the committed artifact and exact-head
CI are recorded separately in the operator directory and integration return.
