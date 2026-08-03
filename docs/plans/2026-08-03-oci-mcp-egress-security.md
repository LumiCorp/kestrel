---
id: oci-mcp-egress-security
domain: security
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-03
depends_on:
  - ../../SECURITY.md
  - ../../apps/mcp-service/README.md
---

# OCI MCP egress security

## Scope

This delivery is limited to environment-installed OCI MCP containers. It does
not cover host stdio MCP servers, shells, browsers, package managers, other
code containers, hosted workspace processes, or remote MCP clients.

## Sequential delivery

1. The control-plane phase makes `none` the custom OCI default, defines the
   strict versioned exact-destination policy, migrates existing OCI rows to
   `none`, binds policy and image identity into hosted profiles and run grants,
   and persists typed egress evidence. `allow_hosts` remains network-off until
   its enforcement boundary exists.
2. The enforcement phase adds the digest-pinned trusted gateway and a dedicated
   per-launch internal network. Only the gateway resolves and dials authorized
   destinations; raw sockets, alternate DNS, redirects, subprocesses, IPv6,
   metadata targets, and removed proxy variables cannot gain another route.

There is no proxy-variable-only fallback. If gateway configuration, isolation,
DNS pinning, policy evidence, or cleanup cannot be verified, launch fails
closed.

## Policy

- `none`: no container network.
- `allow_hosts`: one to 64 exact canonical hostname, port, and HTTP protocol
  tuples. Literal IPs, wildcards, patterns, URLs, paths, ranges, CIDRs, and
  dynamic discovery are rejected.
- `unrestricted`: custom OCI only, with organization-administrator risk
  acknowledgement and justification. Managed OCI unrestricted mode is denied.

Policy changes create a new server revision. No destination is invented for a
managed or legacy server, and no allowlist can fall back to unrestricted mode.

## Audit boundary

This work improves OCI-specific default-deny and bypass-resistance evidence. It
does not by itself complete controls 178 or 180, because those controls cover
every process family that can perform network egress.
