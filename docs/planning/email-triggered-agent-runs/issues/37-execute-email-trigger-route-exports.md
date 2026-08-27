# Execute the Email Trigger route exports

## Failed behavior

The Email Trigger API test reads route source and checks regular expressions, while the PostgreSQL test calls store functions directly. No test invokes the configured GET, POST, PATCH, DELETE, or rotate production exports, so session resolution, active-Organization selection, strict parsing, status shaping, and route-to-store authorization are not executable proof.

## Affected work

This repairs [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) in change `73c5375f3..049c82bef`, specifically its explicit API and authorization completion condition.

## Repair requirements

Execute the actual production route exports with real Better Auth sessions, Organization and Project membership rows, and request headers. Prove unauthenticated requests stop before body reading, ordinary members can GET and copy the full private address but cannot mutate, editors can create and mutate, cross-Organization callers cannot discover the Trigger or address, and strict schemas reject public mode and configurable Execution Owner fields. Exercise stale revisions and response status/body shaping through PATCH, DELETE, and rotate. Do not substitute source assertions, separately constructed handlers, or fake authorization callbacks; use the smallest request-aware auth seam needed by the production exports.

## Done when

- Tests invoke the configured GET, POST, PATCH, DELETE, and rotate exports.
- Real unauthenticated, member, editor, and cross-Organization sessions prove the intended authorization and address-disclosure boundary.
- Public/owner input smuggling, malformed input, and stale revisions return stable non-success responses without unauthorized mutations.
- Rejected unauthenticated mutation bodies prove authorization occurs before parsing.
- Route tests are registered in the PostgreSQL gate and preserve the existing store and UI contracts.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
