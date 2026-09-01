# Prove Resend key replacement through One and Desktop routes

## Useful outcome

The real Kestrel One and Desktop management routes prove that an Admin can replace a write-only Resend key while both surfaces return the same redacted connection truth and safe failures.

## Failed behavior

Issue 42 proves replacement only by calling `saveReceivingConnection` directly. The One/Desktop route tests exercise authorization and generic errors but never send a replacement request through the actual route exports, so request parsing, write-only projection, error mapping, audit ordering, and surface parity are not proven vertically.

## Affected work

This repairs [Replace Resend credentials without orphaning webhook staging](42-replace-resend-credentials-safely.md) in `38c2712e9..d95a29238`, specifically the hosted and Desktop receiving management route contracts.

## Repair requirements

- Exercise the actual Kestrel One and Desktop receiving route exports or their exact production handlers after their real authorization boundary.
- Prove a different valid key for the same provider account retains one webhook ID, remains staged-disabled, and never returns either plaintext or encrypted key material.
- Prove a different-account or insufficient-authority key returns the same safe actionable error on both surfaces and leaves prior durable state unchanged.
- Prove ambiguous-create replacement is rejected identically by both surfaces without a provider create, reconciliation through the candidate key, or durable mutation.
- Preserve One audit ordering: success is recorded only after the replacement commits; Desktop and One public projections remain equivalent.
- Use controllable provider dependencies at the route-handler seam; do not call live Resend or weaken production authorization.

## Done when

- One and Desktop route-level replacement success and rejection tests pass against the durable PostgreSQL state.
- Key, signing secret, locator, provider ID, endpoint, and provider diagnostics remain absent from HTTP error bodies and write-only success projections as appropriate.
- Existing service-level concurrency and duplicate-create proofs remain green.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
