# Accept the real QA WebSocket proxy form

## Failed behavior

The hosted Gateway upgrade parser accepts `http://` absolute-form request targets, but Chromium sends an explicit proxy request for a plain QA WebSocket as `GET ws://host/path`. The real request is rejected before authorization while the focused test uses the wrong wire form.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns the shared authenticated HTTP upgrade listener and exact QA destination mapping.

## Repair requirements

- Accept only an absolute `ws://` request target for the plain authenticated upgrade path.
- Map `ws://` to the existing exact `http` QA destination authority without widening host, port, path, credential, revision, or DNS policy.
- Keep `wss://` on the existing authenticated CONNECT path.
- Exercise the real `ws://` absolute-form wire request in focused tests.

## Done when

- An authenticated exact QA `ws://` handshake and bidirectional exchange succeed.
- `http://`, `https://`, relative, credential-bearing, fragmented, wrong-host, and wrong-port upgrade targets fail closed.
- Focused Gateway upgrade and typecheck suites pass.

## Depends on

None.
