# Proxy authorized QA WebSockets

## Failed behavior

The shared Gateway listener rejects every plain HTTP `upgrade`, so an exact authorized QA target using `ws://` cannot operate. Secure public `wss://` happens to traverse CONNECT, but that does not satisfy the QA WebSocket contract or prove upgrade-specific revocation behavior.

## Affected flow

The shared Environment Gateway listener owns authenticated HTTP upgrades. The repair must reuse the same exact destination policy, DNS safety, reservation, revision, and cleanup transaction as HTTP and CONNECT.

## Repair requirements

- Authenticate the proxy credential before accepting an upgrade.
- Parse and authorize only the exact QA `ws://` destination allowed by current Session authority.
- Apply public-address validation, post-DNS revision checks, and revocation-visible reservation before upstream bytes.
- Sanitize hop-by-hop and proxy credentials while preserving the WebSocket handshake fields the destination owns.
- Close established and in-flight sockets on revocation, Session close, expiry, client loss, timeout, or Gateway close.

## Done when

- An authorized exact QA WebSocket handshake and bidirectional exchange succeed through the Gateway.
- Wrong credential, host, port, Session, generation, revision, and private-address rebinding fail closed.
- Revocation before and after upstream connection sends no later unauthorized bytes and reports one exact closed connection.
- Focused upgrade, DNS, credential-isolation, revision, timeout, and cleanup tests pass.

## Depends on

None.
