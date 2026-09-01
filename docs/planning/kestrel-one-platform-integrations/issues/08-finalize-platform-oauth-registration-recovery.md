# Finalize Platform OAuth registration recovery

## Useful outcome

A Platform Admin can always repair a broken stored registration by rotating its secret, and no malformed legacy client ID or tenant/issuer value can be advertised ready or reach the hosted authorization broker. The legacy-setting migration is proven against a real before-and-after database fixture, including preservation of valid rows.

## What changes

Repair the review findings from issue 07. When an administrator supplies a nonempty replacement secret, failure to decrypt the previous ciphertext (for example a retired key or a corrupt envelope) must be treated as a rotation: encrypt and persist the replacement within the existing revision/audit transaction. A successful equal plaintext comparison remains the only same-secret no-op case.

Extend stored-state validation to require a nonblank canonical client ID and distinguish a raw stored null from a raw blank tenant/issuer value. Every invalid persisted identity or provider setting must produce safe `configuration_error` public state and must be rejected before active registration resolution/decryption. Update the legacy migration to disable and revision blank tenant/issuer rows where needed without reinterpreting values.

Replace the source-text-only migration proof with a Postgres-backed before/after fixture that applies the data repair and verifies invalid legacy rows are disabled and revisioned while valid null, `organizations`, and tenant-GUID registrations remain unchanged.

## Requirements and delivery context

- This completes the Platform registration repair chain only. Do not begin the hosted authorization broker, provider OAuth callbacks, Desktop work, or Better Auth changes.
- A supplied replacement secret must be recoverable even when the old credential cannot be decrypted. Do not reveal or log either secret or ciphertext.
- Stored-state validation must inspect raw persisted values before normalization. Whitespace is invalid persisted identity/tenant data, not absent configuration.
- The data repair must be deterministic and preserve valid provider registrations. Invalid values remain visible only through safe admin configuration state for correction.
- Retain optimistic concurrency, no-op semantics, descriptor-derived scopes, and atomic redacted audit evidence from issues 06–07.

## Done when

- A missing old encryption key or corrupt stored envelope does not prevent an administrator from rotating to a supplied replacement secret.
- Blank or whitespace stored client IDs and tenant/issuer settings produce safe configuration-error status and active resolution refuses before returning a secret.
- The legacy migration disables/revisions all invalid affected rows and preserves valid Google/Microsoft rows exactly.
- Isolated Postgres tests execute the migration fixture and prove recovery, rejection, redaction, and preservation behavior.

## Depends on

- [07 — Complete Platform OAuth registration repair](07-complete-platform-oauth-registration-repair.md)
