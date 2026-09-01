# Block Browser worker reverse channels

## Failed behavior

The worker nftables ceiling defines only an output chain. Any private-network peer can initiate a connection to a listener opened by a compromised worker process, after which worker responses pass as established traffic and bypass Gateway destination policy.

## Affected flow

The Browser worker image entrypoint owns the namespace input and output ceiling. Hosted control routing owns the exact peer permitted to initiate worker control connections. The repair must preserve control reachability without granting arbitrary private ingress.

## Repair requirements

- Add a default-drop input chain before untrusted worker code starts.
- Permit loopback and established replies to worker-initiated traffic.
- Permit new control connections to port 43105 only from the exact authenticated control/Gateway peer carried by Machine provisioning.
- Reject every other public, private, east-west, metadata, and alternate-port inbound flow.
- Keep the process at uid/gid 10001 with empty capabilities and `no_new_privs` after both chains install.

## Done when

- Routed image/network smoke proves an unauthorized private peer cannot connect to worker control or an arbitrary listener opened inside the worker namespace.
- The exact authorized control path still drives Browser open and close.
- Worker responses cannot create a reverse exfiltration channel through an inbound connection.
- Same-peer alternate ports, direct output, DNS, Gateway loss, and privilege-drop proofs remain green.
- Live Fly canary proves the exact input/output rules and control peer on a real Machine.

## Depends on

None.
