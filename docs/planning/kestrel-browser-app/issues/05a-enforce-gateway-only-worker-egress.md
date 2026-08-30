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

## Implemented boundary

- Browser Machine provisioning binds the worker to the owning Environment's
  exact Gateway Machine hostname and dedicated shared proxy port 43109.
- The image entrypoint resolves one Gateway address before untrusted code
  starts, installs a default-drop nftables output chain that explicitly denies
  DNS and permits only that address and port, then drops to uid/gid 10001 with
  an empty capability set and `no_new_privs`.
- The hosted worker rejects a proxy binding for any other host or port and
  replaces the validated internal hostname with the init-pinned address before
  Chrome starts. Environment Gateway still selects the exact session policy by
  authenticated per-session proxy credentials on the shared listener.
- The routed local image smoke proves direct public, private/east-west,
  steady-state DNS, and alternate Gateway-port attempts fail from the worker
  namespace while the authenticated Browser path succeeds.

Exact live Fly proof remains required: the candidate Machine must demonstrate
init-time nftables authority is available in the guest, privilege is dropped
before the worker becomes ready, direct probes remain denied, and a real
Gateway-authorized preview and public HTTPS/443 canary both succeed.
