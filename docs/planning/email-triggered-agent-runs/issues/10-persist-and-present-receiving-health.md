# Keep receiving health evidence truthful after failed checks

## Failed behavior

After a saved credential is revoked or Resend becomes unavailable, checking the stored connection returns an error but leaves the hosted projection marked `full_access` and `ready_inactive`. The failed attempt and stable reason disappear on refresh, and both management surfaces omit part of the server-owned readiness and health evidence.

## Affected work

This repairs [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md) in change `514b6a8a1..9fff57b6d`, including `apps/web/lib/email/receiving-config.ts`, `apps/web/components/settings/receiving-client.tsx`, and the Desktop receiving view in `apps/desktop/renderer/src/SettingsWorkspace.tsx`.

## Repair requirements

Checks of the currently stored credential must durably update credential sufficiency, health-check time, and a stable redacted failure reason. A failed explicit replacement key must not poison evidence for a still-authoritative stored key. Kestrel One and Desktop must render the same server-owned overall readiness, inbound state, validation or health times, and safe failure evidence without inferring readiness locally or exposing secrets.

## Done when

- Revoking the stored key and checking it persists insufficient-credential evidence visible after refresh in both clients.
- Provider outage and recovery update durable redacted health evidence without replacing a known-good stored credential.
- Focused service and presentation regressions cover the failure and recovery paths.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
