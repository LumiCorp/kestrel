# Execute the configured receiving route exports

## Failed behavior

Issue 21 executes fresh handlers created from the shared mutation factories with injected authorization callbacks. Those tests prove parsing and response shaping, but they do not invoke the four production route exports or prove that each export is bound to its intended Organization-Admin authorization seam. A signature-compatible member authorization function could therefore be wired to a Desktop mutation while the tests remained green.

## Affected work

This repairs [Execute malformed JSON contracts through every receiving route](21-execute-malformed-json-route-contracts.md) in change `0f6898931..14627a55d`, specifically production route binding and executable authorization coverage for the four receiving mutation exports.

## Repair requirements

Execute the exported One receiving PUT, One domains POST, Desktop receiving PUT, and Desktop domains POST handlers through their configured production authorization seams. Prove authorized malformed bodies return the exact 422 invalid-request envelope and unauthenticated or ordinary-member malformed bodies stop at 401 or 403 before the request body is read. Do not substitute another source-text assertion or a separately constructed handler with a fake authorization callback. Keep the shared parser, schemas, services, audit ordering, error redaction, and route signatures unchanged unless the smallest explicit request-auth seam is required to make the production exports executable.

## Done when

- Tests invoke all four production mutation exports rather than separately constructed factory instances.
- The configured One and Desktop authorization seams are exercised for authorized, unauthenticated, and ordinary-member cases.
- All four authorized malformed bodies return the exact 422 invalid-request envelope.
- Every rejected malformed body proves authorization completed before body reading.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
