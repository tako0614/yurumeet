# Local browser authentication — 2026-10-01

Task: GA-20261001-yurumeet-browser-auth, Yurumeet only, after #20.
Parent owns src/components/AuthScreens.tsx, package.json, bun.lock,
.github/workflows/ci.yml, README.md/README.en.md and this ledger.
A bounded worker owns scripts/smoke-release-browser.mjs only.
No shared Core/auth permissions/schema/deploy behavior, real credential/state,
Yurucommu product premise or other worktree change. Existing message-search
differences in the original repository remain protected.

Actual Chrome on the current compiled artifact and fresh local native bindings
confirmed wrong-password refusal, literal whitespace-bearing credential
submission, successful login/reload and persisted salted actor session. It also
confirmed the password input has no associated label and the displayed failure
has no alert role. Fix the product-owned login UI and add a browser artifact
smoke gate for the complete interaction, rather than treating API-only tests
as browser evidence. The optional local toolchain requires installed Chrome;
the CI browser step must run and may not silently skip. Portable `bun run check`
remains independent of that additional browser tool requirement.

Yurucommu's existing #48 artifact passed the same read-only local Chrome probe
with its existing label and alert. No Yurucommu source change is part of this
unit, and its single-human-owner premise is not imposed on Yurumeet.

Local HTTP/disposable workerd browser proof is distinct from public TLS,
deployed self-install, real native UI, OIDC, federation and update/recovery.
Complete the full unchanged-source owner check and the additional browser smoke,
independent review and exact-head CI before integration return.

Regression/review: the old #20 artifact completed actual password authentication
and persisted-session checks, then the new browser verifier refused its missing
associated password label. Independent review found that a page-wide alert count
could accept an unrelated alert and that a failing context close could prevent
the other cleanup attempts. The verifier now requires the visible failure node
itself to be an alert and the invalid input to describe that same node. Cleanup
attempts context, browser and worker independently, preserves the primary error,
and refuses success if cleanup fails. Read-only re-review closed both findings.

A malformed artifact removes the failure's alert role and adds a separate alert:
the archived pre-review-equivalent verifier incorrectly passes it, and the fixed
verifier refuses it after the actual successful login/session checks. An external
fault-injection run closes the actual context then throws; browser and workerd
cleanup still complete and the original visible-error failure remains the exit
reason. These disposable operator mutations are not product source changes.

Final local validation: `bun run check` succeeded on 2026-10-01 with 217 tests,
0 failures and 26 mocked OpenTofu plans, then Chrome 149.0.7827.200 passed all
10 browser checks on the same native-smoke-qualified Worker artifact
`sha256:de256072f1e32d55ddd44689865370b37501ced9d875bfb0b32750c37aee6f43`.
The final gate started without another full check and preserved all tracked and
nonignored untracked source fingerprints through the browser run. This completed
validation paragraph was appended afterward; exact committed-head CI and its
separate artifact identity are recorded in the integration handoff.
