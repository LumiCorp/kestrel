# Reject incomplete Resend domain lists as health evidence

## Failed behavior

The Resend adapter ignores the domain-list envelope and accepts `has_more: true` as a complete result. A stored-key health check can then treat an omitted configured domain as removed and persist false failed-domain evidence.

## Affected work

This repairs [Keep receiving health evidence truthful after failed checks](10-persist-and-present-receiving-health.md) in change `485870e58..f00316da3`, specifically domain-list parsing in `apps/web/lib/email/receiving-provider.ts` and its use by `apps/web/lib/email/receiving-config.ts`.

## Repair requirements

Only a complete, valid Resend domain-list envelope may update stored domain health. An incomplete or contradictory list must become stable invalid-upstream evidence and must not be interpreted as proof that the configured domain disappeared. Preserve acceptance of a valid complete empty list.

## Done when

- `has_more: true`, malformed envelopes, and contradictory pagination evidence fail as `RESEND_RECEIVING_RESPONSE_INVALID` without false domain removal evidence.
- A complete empty list remains valid and marks the configured domain unavailable only through the settled health path.
- Focused provider and stored-health regressions cover both cases.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
