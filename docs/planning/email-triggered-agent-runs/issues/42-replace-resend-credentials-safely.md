# Replace Resend credentials without orphaning webhook staging

## Useful outcome

An Organization Admin can replace the write-only Resend Full access key from Kestrel One or Desktop while Kestrel preserves exactly one disabled staged webhook and never rebinds ambiguous provider work to another credential authority.

## Failed behavior

The current save rejects every different key after a provider webhook ID is stored, so the settled key-replacement workflow becomes impossible. Before the ID is stored, the opposite failure is possible: a different key can overwrite a row with a durable create intent or attempted create. If the old provider accepted that POST, its enabled webhook is orphaned while recovery searches the new credential's account.

The pre-lock replacement check is also staleable. Provider evidence can appear while the candidate key is being validated, after which the save transaction can still overwrite the authoritative credential and retain incompatible webhook evidence.

## Affected work

This repairs [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md) in change `1dca25008..65a832172`, specifically `apps/web/lib/email/receiving-config.ts`, `apps/web/lib/email/receiving-webhook-staging.ts`, and their hosted management error contracts.

## Repair requirements

- Permit a replacement Full access key when the candidate can prove authority over the currently persisted provider webhook. Retain and re-verify the existing webhook ID and encrypted signing secret, re-encrypt the candidate key, disable ingress during the transition, and finish in the same staged-disabled state.
- Treat an attempted create without durable provider identity as ambiguous authority. A different credential must not clear, adopt, or reconcile that intent against another provider account.
- Recheck the authoritative encrypted key, staging sequence, create intent/attempt, provider ID, and signing-secret evidence under the existing Organization advisory lock immediately before persistence. A pre-lock read is not sufficient.
- If the candidate cannot manage the existing provider webhook, reject it without changing the stored key, locator, provider evidence, staging sequence, readiness, or error truth. Do not claim that an unavailable decommission workflow exists.
- Bind post-save staging to the exact committed credential generation so a superseded caller cannot report another save's staging result as its own.
- Preserve one provider webhook, the opaque locator, write-only key handling, Desktop/Kestrel One parity, and safe redacted HTTP errors.

## Done when

- A different valid key for the same Resend account replaces the stored key and re-verifies the existing webhook without a second create.
- A candidate from another account or without authority over the existing webhook is rejected atomically with the prior configuration unchanged.
- Replacement racing durable intent creation, an ambiguous accepted POST, evidence persistence, webhook disablement, and another save cannot orphan an enabled webhook or reconcile through the wrong key.
- Same-key retries still recover every persisted provider checkpoint.
- Kestrel One and Desktop route-level tests prove write-only replacement, safe error projection, and hosted state parity.
- Focused PostgreSQL concurrency, crash-window, provider-authority, stale-result, duplicate-create, and redaction tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
