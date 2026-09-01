# Terminalize rejected upgrade sockets

## Failed behavior

Rejected WebSocket upgrades call `socket.end()` without tracking or force-closing the upgraded socket. A half-open client can retain the socket and keep `closeAll()` pending indefinitely.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns the listener-level authentication rejection, policy rejection, and Gateway shutdown lifecycle for upgraded sockets.

## Repair requirements

- Make every rejected upgrade response terminal from the Gateway side even when the client permits a half-open connection.
- Do not retain rejected sockets outside the exact Gateway lifecycle or rely on client cleanup.
- Preserve the bounded `407` authentication response and stable policy-denial behavior without leaking destination or credential data.
- Prove Gateway shutdown converges without destroying the test client first.

## Done when

- Wrong-credential and policy-rejected half-open upgrade clients cannot retain a Gateway socket.
- `closeAll()` completes after rejection with no client-side cleanup precondition.
- Focused upgrade, shutdown, and cleanup tests pass.

## Depends on

None.
