---
id: mcp-network-access-superseded
domain: security
status: deprecated
owner: kestrel-runtime
last_verified_at: 2026-08-03
depends_on:
  - 2026-08-03-oci-mcp-egress-security.md
---

# MCP network access (superseded)

This accepted-risk design is superseded by
[OCI MCP egress security](2026-08-03-oci-mcp-egress-security.md). The historical
contract below is retained only to explain the prior behavior.

## Scope

This design covers environment-installed OCI MCP servers. Remote MCP servers
always require networking. Developer-shell isolation remains a separate task.

## Ownership

- Observed wrong behavior: environment-installed OCI MCP servers launch with
  Docker networking disabled unless an origin allowlist is configured.
- First component that makes it wrong: `buildOciDockerRunCommand` defaults
  `--network` to `none`.
- Owning repair surface: the MCP server installation contract and OCI process
  launch boundary.

## Contract

OCI MCP servers have exactly two modes:

```json
{ "networkAccess": "full" }
```

`full` is the default and launches on Docker's bridge network. `none` is an
explicit installation choice and launches with `--network none`. Remote MCP
servers accept only `full` because reaching the configured remote server is
their transport.

The administrator is trusted to choose the servers installed in an
Environment. Container isolation protects the host and restricts filesystem
access to explicit read-only mounts; it does not promise outbound-network
containment. An enabled OCI MCP server can contact arbitrary destinations and
can use only the credentials and mounted data explicitly configured for it.

There are no destination lists, per-capability network grants, egress brokers,
or heuristic exceptions. Existing server and capability authorization remains
unchanged.

## Proof matrix

| Behavior | Owning proof |
| --- | --- |
| Default | An OCI server installed without `networkAccess` persists `full` and launches with `--network bridge`. |
| Isolation | An OCI server installed with `networkAccess: "none"` launches with `--network none`. |
| Remote MCP | Remote configuration rejects `none` and retains public-HTTPS and DNS-pinning protections. |
| Audit and replay | Existing server identity, capability policy, request digest, response digest, and grant lifecycle remain the replay contract. |

## Deferred

Developer-shell network isolation is not implemented by this slice.
Destination allowlists and egress brokers are not planned because unpredictable
network access is intrinsic to normal MCP usage. The audit's default-deny
egress zero is accepted risk rather than unfinished implementation.

Filesystem descriptor-relative TOCTOU hardening is also deferred until
mutually untrusted workspace writers enter the supported threat model.
