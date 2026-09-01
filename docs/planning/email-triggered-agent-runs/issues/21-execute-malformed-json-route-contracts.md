# Execute malformed JSON contracts through every receiving route

## Failed behavior

Issue 19's helper test executes JSON classification once, but its all-route proof only inspects source text. It does not invoke each One and Desktop handler to prove authorized malformed bodies return 422 while unauthenticated or non-Admin malformed bodies stop at 401 or 403.

## Affected work

This repairs [Classify malformed receiving JSON as an invalid request](19-classify-malformed-receiving-json.md) in change `026050c75..ffef42701`, specifically the acceptance coverage for all four receiving mutation routes.

## Repair requirements

Exercise the real route handlers, their existing auth seams, shared parser, and final HTTP response shaping. Do not replace handler execution with source regex assertions. Preserve authentication-before-body behavior and redaction.

## Done when

- Both One handlers return the exact 422 invalid-request envelope for an authorized malformed body.
- Both Desktop handlers return the exact 422 envelope for an authorized malformed body.
- Executed unauthenticated and non-Admin malformed-body cases return 401 or 403 before parsing disclosure.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
