# Local browser talk and media — 2026-10-01

Task: GA-20261001-yurumeet-talk-media, Yurumeet only, after #21.
Parent owns src/styles.css, scripts/smoke-release-browser.mjs,
scripts/release-browser-talk.mjs, README.md/README.en.md and this ledger.
A bounded worker owns src/lib/media-upload.ts and its SDK contract tests,
and only media imports/calls in App.tsx, ChatPane.tsx, ProfileEditModal.tsx,
PostComposer.tsx and CommunityPage.tsx. No other edits, shared Core/schema,
auth permissions, deployment, real data or Yurucommu premise changes.

Actual old-artifact Chrome cannot normally select a contact row because the
archive control inherits the main button's full row width and height, intercepting
the pointer. Narrow that product-owned selector and verify real contact clicks.
Published API4.1.7 also refuses Japanese filenames before upload. The Core
server ignores the multipart filename and owns the UUID/MIME storage basename.
One product adapter must supply an ASCII transport basename while preserving
the original File bytes/type/lastModified and using all existing SDK validations.
Route all five product upload callers through it; retain original video names
for product display and attachment metadata. No conditional compatibility retry
or SDK/backend validation change.

Extend actual native/Chrome artifact smoke to contact selection, DM persistence,
upload/attachment byte readback and failed-send retry. Only after the real first
password login may a synthetic non-owner communication peer be inserted; real
Core DM POST may create a fixture opener for the existing-conversation list.
This is synthetic/local communication evidence, not real external participation,
OIDC/native-client/public TLS, federation or deployment/recovery qualification.

Upload cancellation currently drops local preview state but has no shared
authenticated deletion/expiry/GC contract. Propose that remaining storage
lifecycle condition to the principal; do not invent a product storage-delete
authority or call nonexistent routes. Keep Yurucommu's single-human-owner
requirement separate. Complete read-only full gate, independent review,
actual browser regressions and reviewed-head CI before integration return.

Observed regression evidence is kept outside the repo at operator-runs/
yurumeet-ga-browser-talk-20261001. The old b0d3143 browser artifact's physical
contact-center click hits the archive control and persists an archive row.
An explicitly recorded CSS-only variant of those old bytes isolates the media
path: an ASCII PNG uploads, the identical Japanese-named PNG is refused before
HTTP, and removing the staged ASCII upload leaves both its DB row and R2 bytes.
That variant is a diagnostic, not qualification of a new source build.

The product helper validates a metadata-only Proxy through the installed SDK
before reading bytes or constructing a transport File. Only the multipart name
changes; the original File remains intact. Four SDK-facing tests also prove
invalid MIME/oversize inputs cause no byte read, File construction or HTTP call.
The transport File uses independent bytes because File/Blob alias construction
in the local Bun toolchain can mutate the original name during FormData upload.
