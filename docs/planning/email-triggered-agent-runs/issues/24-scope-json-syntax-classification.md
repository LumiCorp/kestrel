# Scope malformed JSON classification to the explicit parse operation

## Failed behavior

The shared helper wraps every `SyntaxError` thrown by `request.json()` as caller-invalid JSON. An internal or instrumented body-reader `SyntaxError` is therefore misclassified as 422 instead of remaining a redacted 500.

## Affected work

This repairs [Classify malformed receiving JSON as an invalid request](19-classify-malformed-receiving-json.md) in change `026050c75..ffef42701`, specifically `parseReceivingAdminJson` in `apps/web/lib/email/receiving-admin-error.ts`.

## Repair requirements

Read the request body through the platform boundary and classify only failure from Kestrel's explicit JSON parse operation as malformed syntax. Body-read failures and unrelated internal `SyntaxError`s remain redacted internal failures. Keep auth before body access and preserve the stable 422 envelope for genuinely malformed JSON.

## Done when

- Explicit malformed JSON returns the stable 422 invalid-request envelope.
- A body-read failure and an internal `SyntaxError` both remain redacted 500 responses.
- Focused tests execute these distinct paths without relying on error-message matching.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
