# Close an unfinished upload after an early response

## Failed behavior

An allowed upstream can complete its response before the Browser finishes its request body. Response completion currently releases the exact reservation and upload timer while the Browser-side request socket remains open and writable, so revision loss, Session close, hard expiry, and request-body idle cleanup no longer own it.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns the full duplex lifetime of one ordinary HTTP proxy transaction. Response completion alone is not proof that an unfinished request direction is terminal.

## Repair requirements

- Keep the transaction reserved until both request and response directions are terminal, or explicitly terminate the unfinished Browser request side when accepting an early upstream response.
- Preserve a complete bounded upstream response when it can be delivered safely; do not allow an unfinished request to outlive exact Session authority.
- Ensure request-body idle timeout, revision revocation, exact close, hard expiry, client loss, and Gateway close can still terminate every unfinished resource.
- Add a deterministic early-response regression covering incomplete request state, timeout, revision loss, exact close, and zero retained sockets.
- Add no retry, fallback, request replay, or second dispatch.

## Done when

- An early completed response leaves no untracked writable Browser request.
- An unfinished upload closes under its exact timeout and every authority-loss path.
- Normal progressing uploads and ordinary response lifecycle tests remain green.
- Focused Gateway HTTP, cleanup, and typecheck suites pass.

## Depends on

None.
