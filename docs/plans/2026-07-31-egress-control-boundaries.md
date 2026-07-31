# MCP network access

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
