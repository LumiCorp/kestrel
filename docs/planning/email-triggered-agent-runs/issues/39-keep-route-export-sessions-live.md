# Keep route-export sessions live

## Failed behavior

The production Email Trigger route regression fixes every Better Auth session expiry at `2026-08-27T16:10:00Z`. Once wall-clock time passes that instant, all authenticated requests become unauthorized and `validate:postgres` fails even though the route behavior is unchanged.

## Affected work

This repairs [Execute the Email Trigger route exports](37-execute-email-trigger-route-exports.md) in change `ef076fa69..32d0f6fe9`, specifically its durable PostgreSQL route proof.

## Repair requirements

Derive authentication session creation and expiry from the test's current execution time so the sessions are valid whenever the test runs. Keep deterministic business timestamps where wall-clock authority is irrelevant. Preserve execution of the actual GET, POST, PATCH, DELETE, and rotate exports and all existing unauthenticated, role, tenant, parsing, concurrency, and response assertions. Do not weaken authentication or bypass Better Auth session expiry.

## Done when

- The route-export PostgreSQL fixture creates currently valid Better Auth sessions without a fixed calendar expiration.
- The proof still exercises all five production route exports through real session resolution.
- Existing authorization-before-body, role, cross-Organization, strict-input, revision-conflict, rotation, and deletion assertions remain intact.
- The focused route regression and `pnpm validate:postgres` pass after the original fixed expiration.
- The affected issues' original outcomes and constraints still hold.

## Depends on

None.
