# Keep removed-domain failures separate from credential health

## Failed behavior

When Resend returns an authenticated 404 for the configured domain, stored health marks the credential as `error` while leaving the old verified domain and MX evidence intact. The projection simultaneously reports a credential failure and a verified domain even though the failure proves the domain resource is unavailable.

## Affected work

This repairs [Keep receiving health evidence truthful after failed checks](10-persist-and-present-receiving-health.md) in change `485870e58..f00316da3`, specifically failure classification and persisted health updates in `apps/web/lib/email/receiving-config.ts`.

## Repair requirements

Credential, provider, and domain outcomes must update only the evidence they establish. An authenticated missing or invalid configured domain preserves `full_access`, marks that matching domain failed with unknown MX, records the stable domain failure and health-check time, and never retains contradictory verified-domain evidence. Candidate replacement failures remain side-effect free.

## Done when

- A stored-key 404 for the configured domain preserves credential sufficiency and persists failed-domain evidence visible after refresh.
- Credential rejection still downgrades credential evidence without inventing a domain result.
- Provider unavailability remains distinct and recovery clears the relevant stable failure.
- Focused PostgreSQL regressions cover these transitions.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
