# Enforce Gateway-only Browser worker egress

## Failed behavior

Issue 05 declares Environment Gateway as the hosted Browser worker's sole egress owner, but the Fly Machine configuration only records descriptive environment variables and removes inbound services. It installs no outbound network ceiling, and the current image smoke proves a successful direct worker-to-preview connection.

## Affected flow

The hosted Browser worker Machine/network deployment owns the outbound ceiling. Environment Gateway continues to own authenticated destination policy. The repair must make bypass impossible for Chrome, the worker server, and any compromised process in the worker namespace.

## Repair requirements

- Deny direct public, private, east-west, metadata, and DNS egress from the Browser worker namespace by default.
- Permit only the authenticated Environment Gateway/control path and the minimum platform plumbing required to reach it.
- Keep Chrome QUIC, WebRTC, proxy bypass, and alternate resolver paths disabled.
- Make the enforcement part of the actual Machine or network configuration, not an environment label interpreted only by tests.
- Preserve the dedicated no-volume worker and immutable-image boundaries.

## Done when

- A real worker-image/network smoke proves direct public and unauthorized private/east-west requests fail from both Chrome and a non-Chrome process.
- The same smoke proves an authorized preview and public HTTPS/443 destination work only through the authenticated Gateway.
- Gateway loss or invalid credentials fail closed; no fallback route exists.
- Fly-provider, worker-image, proxy-bypass, DNS, and live environment canaries pass.

## Depends on

None.
