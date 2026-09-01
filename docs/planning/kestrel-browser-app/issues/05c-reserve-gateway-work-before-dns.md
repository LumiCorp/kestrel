# Reserve Gateway work before DNS

## Failed behavior

Gateway HTTP and CONNECT requests await DNS before creating a revocation-visible reservation. If the Session proxy closes, expires, the client disconnects, or the same Session is reinstalled during that wait, the detached old proxy can still reserve and create upstream traffic afterward.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns authenticated request admission, DNS, reservations, and Session proxy lifecycle. One exact reservation must cover the request from before the first await until terminal release.

## Repair requirements

- Create a cancellable reservation and attach client close/abort before DNS begins.
- Make reservation admission atomically reject a closed or superseded proxy.
- Recheck Session lifecycle, revision, and destination after DNS and immediately before dial or request creation.
- Ensure a late DNS result cannot attach resources or send bytes after close, expiry, abort, or reinstall.
- Release the reservation on every DNS rejection, resolver failure, client loss, and Gateway close path without double counting.

## Done when

- Deterministic delayed-DNS HTTP and CONNECT tests prove close, expiry, client disconnect, and same-ID reinstall send zero upstream bytes.
- A fresh request on the reinstalled exact Session succeeds under only the new proxy.
- Adoption closed counts remain exact and all reservation counts return to zero.
- Focused Gateway lifecycle, DNS, revision, HTTP, CONNECT, and cleanup tests pass.

## Depends on

None.
