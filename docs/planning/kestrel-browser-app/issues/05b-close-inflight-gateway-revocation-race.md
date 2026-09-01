# Close the in-flight Gateway revocation race

## Failed behavior

The hosted QA HTTP proxy rechecks the allowlist revision before creating `http.request`, but it does not track the connection until the asynchronous socket callback. If revocation adopts in that gap, adoption sees nothing to close and the callback can send the now-revoked request without another authority check.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns admission and connection tracking for every Gateway request. The repair must make authorization reservation and network send one revocation-safe transaction without adding retries or changing Browser policy.

## Repair requirements

- Register a revocation-visible reservation before asynchronous socket allocation, or revalidate exact Session, generation, destination, and revision before any request bytes can leave.
- Ensure adoption closes or invalidates both established connections and in-flight reservations that are no longer authorized.
- Apply the same invariant to ordinary HTTP, CONNECT, WebSocket upgrades, redirects, and any future Gateway transport.
- Release reservations on every success, rejection, socket failure, client disconnect, timeout, and Gateway close path.
- Preserve the exact closed-connection receipt semantics without double-counting one request.

## Done when

- A deterministic delayed-socket interleaving proves revocation between DNS approval and socket assignment sends zero upstream bytes.
- Grant adoption permits the next exact request under the new revision without retrying the revoked request.
- Connection and reservation counts return to zero after rejection, failure, disconnect, timeout, and close.
- Focused Gateway DNS, redirect, socket, WebSocket, revision-adoption, and cleanup tests pass.

## Depends on

None.
