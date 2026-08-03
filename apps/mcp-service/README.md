# Kestrel MCP service

The MCP service is Kestrel One's credential-bearing MCP boundary. It activates
short-lived run grants, hosts the Streamable HTTP endpoint consumed by the
runner, discovers Environment capabilities, proxies approved remote MCP
servers, and launches digest-pinned OCI MCP servers.

The runner receives only the gateway URL, grant identifier, and signed
Environment execution ticket. Upstream OAuth tokens and secret headers remain
encrypted in the control-plane database and are decrypted only in this
service.

## Required configuration

- `DATABASE_URL`: control-plane PostgreSQL connection.
- `KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY`: public key used to authenticate
  execution tickets.
- `KESTREL_MCP_CREDENTIAL_ACTIVE_KEY_ID` and `KESTREL_MCP_CREDENTIAL_KEYS`:
  the same credential keyring configured in Kestrel One.
- `KESTREL_MCP_ALLOWED_ORIGINS`: comma-separated browser origins accepted by
  the Streamable HTTP endpoint. Server-to-server requests without an Origin
  header are accepted after ticket authorization.
- `KESTREL_MCP_WORKSPACE_ROOT`: canonical parent directory containing one
  directory per Environment workspace identifier.

`GET /health` reports database reachability, active session count, and
discovery worker status. It never returns credentials, request bodies, or MCP
responses.

## OCI execution boundary

OCI support requires a Docker-compatible daemon and a workspace filesystem
visible to that daemon at exactly the path configured by
`KESTREL_MCP_WORKSPACE_ROOT`. Deploy this service on the trusted Environment
execution host or on a worker with the same read-only workspace mount; a
central service without that mount cannot satisfy the Project-root isolation
contract.

Each run starts the MCP server with a read-only root filesystem, dropped
capabilities, no-new-privileges, a non-root user, bounded CPU, memory and PIDs,
and the Project workspace mounted read-only. Custom OCI servers default to no
network. Exact allowlists are bound to the image digest, tenant, Environment,
server revision, and hosted execution-profile fingerprint. This contract-only
phase keeps both `none` and `allow_hosts` on `--network none`; it never weakens
an allowlist to Docker bridge access while the trusted gateway is unavailable.

Unrestricted bridge networking requires the exact custom-server policy with an
organization-administrator acknowledgement and justification. Managed OCI
servers cannot use unrestricted mode. Remote MCP networking and its existing
public-HTTPS DNS-pinned connection path are unchanged.

Egress policy and lifecycle evidence is stored in the typed
`mcp_egress_events` surface. Evidence contains canonical host, port, protocol,
address classification, and typed denial data when applicable; it must not
contain credentials, headers, paths, queries, request bodies, full URLs, or
secret-bearing environment variables.

When the service itself is containerized, the deployment must supply a
constrained Docker API endpoint and the workspace mount. Mounting an
unrestricted host Docker socket gives the service host-equivalent authority
and is not an acceptable multi-tenant production configuration.

Build from the repository root:

```sh
docker build -f apps/mcp-service/Dockerfile -t kestrel-mcp-service .
```
