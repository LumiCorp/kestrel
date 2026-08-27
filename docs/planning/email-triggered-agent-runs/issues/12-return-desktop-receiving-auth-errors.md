# Return authentication errors for invalid Desktop receiving credentials

## Failed behavior

Desktop receiving routes correctly reject a missing, expired, malformed, or revoked bearer token, but the receiving error mapper turns the typed Desktop authorization error into HTTP 500. Desktop cannot distinguish a sign-in problem from an internal receiving failure.

## Affected work

This repairs [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md) in change `514b6a8a1..9fff57b6d`, specifically `apps/web/lib/email/receiving-admin-error.ts` and the Desktop receiving API routes.

## Repair requirements

The receiving boundary must preserve the existing typed Desktop authentication contract and return a stable 401 response for missing, malformed, expired, or revoked credentials. Organization membership and Admin failures must remain 403, and internal errors must remain redacted.

## Done when

- Route-level checks prove missing, malformed, expired, and revoked Desktop credentials return the stable 401 response.
- Cross-Organization and non-Admin callers remain rejected without leaking receiving state.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
