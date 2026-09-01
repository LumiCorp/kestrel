# Classify malformed receiving JSON as an invalid request

## Failed behavior

The four One and Desktop receiving mutation routes catch malformed JSON, but `request.json()` throws `SyntaxError` and the shared mapper returns a redacted HTTP 500. Clients cannot distinguish invalid request syntax from an internal service failure.

## Affected work

This repairs [Distinguish provider outages from invalid receiving configuration](13-classify-receiving-provider-failures.md) in change `485870e58..f00316da3`, specifically `apps/web/lib/email/receiving-admin-error.ts` and all receiving mutation routes that use it.

## Repair requirements

Authenticated malformed JSON must use the same stable 422 invalid-request contract as schema-invalid JSON. Authentication and authorization must still run first, and unexpected internal exceptions must remain redacted 500 responses.

## Done when

- Malformed JSON at One save/domain-inspection and Desktop save/domain-inspection returns `422 / RESEND_RECEIVING_REQUEST_INVALID` for authorized callers.
- Unauthenticated and non-Admin callers still receive 401 or 403 before body details are exposed.
- Focused executable boundary checks cover all four routes.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
