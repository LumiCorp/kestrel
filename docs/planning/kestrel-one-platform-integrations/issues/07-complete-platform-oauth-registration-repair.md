# Complete Platform OAuth registration repair

## Useful outcome

Platform registration revision remains a truthful authorization-invalidation boundary: unchanged saves do not stale an authorization, and stored registrations that violate the current provider-setting rules cannot be reported ready or consumed by the future broker.

## What changes

Repair two defects found in the independent review of issue 06. Canonicalize requested registration state before mutation. When a requested save is unchanged, return its current redacted configuration without a revision increment or audit event. Keep an actual field change revisioned and audited.

Treat the provider-specific tenant/issuer rule as a read and use boundary, not merely an incoming-save rule. Add a data repair migration for the previously permissive registration rows, then validate stored settings when resolving public status and when requiring an active registration. A stored Google issuer or unsupported Microsoft setting must not be offered as ready or returned to the broker; it must require an administrator correction. Add persistence coverage for legacy invalid rows and for a canonical no-op save.

## Requirements and delivery context

- This is a narrow repair of issue 06. Do not add the hosted authorization broker, provider callbacks, Desktop work, or Better Auth changes.
- A registration revision changes only when the canonical client identity, encrypted secret, tenant setting, enabled state, or pack set changes. An identical save is not a change.
- The database migration must be deterministic and preserve valid Google and Microsoft registrations. Do not silently reinterpret an invalid tenant/issuer value as a different value.
- At every public/active read boundary, invalid persisted values must be rejected or represented as unavailable with a safe configuration error; they must never reach future authorization logic.
- Maintain the atomic redacted audit behavior delivered in issue 06.

## Done when

- An unchanged save leaves its revision and administrative event count unchanged.
- Valid field changes still increment the revision and create one redacted audit event.
- Existing invalid Google or Microsoft tenant/issuer values are repaired or rejected before public readiness and active-broker resolution.
- A migration and Postgres-backed tests prove legacy-row safety, no-op behavior, and preservation of valid registrations.

## Depends on

- [06 — Harden Platform OAuth registration authority](06-harden-platform-oauth-registration-authority.md)
