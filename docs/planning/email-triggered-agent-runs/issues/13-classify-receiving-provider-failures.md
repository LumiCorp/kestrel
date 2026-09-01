# Distinguish provider outages from invalid receiving configuration

## Failed behavior

Resend network and server failures are normalized as provider unavailability but returned by the admin APIs as HTTP 422, the same class used for invalid user configuration. Clients cannot make a correct retry or correction decision.

## Affected work

This repairs [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md) in change `514b6a8a1..9fff57b6d`, specifically the error normalization in `apps/web/lib/email/receiving-provider.ts` and response mapping in `apps/web/lib/email/receiving-admin-error.ts`.

## Repair requirements

Retryable provider unavailability must have a stable service-unavailable response distinct from invalid domain or request state. Invalid provider responses must be distinguishable from both. Credential insufficiency, authorization, and redaction behavior must remain intact across Kestrel One and Desktop routes.

## Done when

- Network and Resend 5xx failures return the documented retryable service status.
- Malformed successful provider payloads return a stable upstream-response failure status.
- Invalid domain or request state remains a non-retryable client correction response.
- Focused boundary tests cover every status class.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
