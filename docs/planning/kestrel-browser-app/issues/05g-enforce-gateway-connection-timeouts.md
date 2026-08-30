# Enforce Gateway connection timeouts

## Failed behavior

Gateway code registers timeout listeners without configuring an HTTP timeout, and CONNECT has no connect deadline. A black-holed dial, stalled headers, or stalled partial response can retain reservations and sockets until client or Session closure, enabling per-Session resource exhaustion.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns bounded connection lifecycle. Timeouts must release the existing exact reservation and resources; they must not add Browser retries or terminate healthy authorized long-lived WebSockets.

## Repair requirements

- Define explicit bounded DNS, TCP connect, HTTP header, and ordinary HTTP body-idle deadlines.
- Apply connect deadlines to CONNECT and WebSocket upstream establishment.
- Keep established authorized WebSocket/tunnel lifetime bounded by Session hard expiry and loss of destination authority on revision adoption rather than an ordinary short body timeout. A revision that still authorizes the exact destination must not terminate the healthy connection.
- Close and release every attached or late resource exactly once on deadline.
- Return only bounded stable Gateway failure behavior; do not leak destinations or credentials.

## Done when

- Deterministic black-holed connect, stalled headers, and stalled body tests prove reservations and sockets return to zero.
- Adoption after each timeout reports no retained connection.
- Healthy long-lived authorized tunnels survive ordinary request deadlines and still-authorized revision adoption, but close when revision adoption removes their exact destination, on Session expiry, and on Gateway close.
- Focused timeout, HTTP, CONNECT, WebSocket, adoption, and cleanup tests pass.

## Depends on

None.
