# Expose audited operator repair for missing file blobs

## Failed behavior

The availability module can verify restored bytes, but no authorized operator route or command calls it. Once a shared blob is marked `missing`, operators cannot restore it through the product's supported operating surface.

## Affected work

This blocks [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md), introduced in local commit `74135b144`. The verifier is `apps/web/lib/files/availability.ts:verifyRestoredFileBlob`; repository search finds no reachable caller.

## Repair requirements

Provide an operator-owned entry point that authenticates and authorizes the repair actor for the organization and exact blob. It must call the existing complete-read, exact-size, and SHA-256 verifier, restore availability only after verification, preserve file identities, grants, message links, and representations, and record the audit event. Invalid bytes, missing objects, and temporary storage errors must not restore availability.

Keep repair separate from file lifecycle, malware scan state, deletion state, and grant mutation. Do not create an automatic destructive repair or expose object credentials, paths, or raw provider errors.

## Done when

- An authorized operator can invoke the repair surface for one exact blob and receive a safe success or stable failure result.
- Unauthorized, cross-organization, missing, temporary, and integrity-mismatch cases are rejected without changing availability.
- A successful repair reads the complete object, verifies recorded size and SHA-256, sets availability to `available`, and records an audit event.
- Focused authorization, integrity, state-transition, and redaction tests pass.
- Issue 01's non-destructive evidence and effective-availability guarantees remain intact.

## Depends on

None.
