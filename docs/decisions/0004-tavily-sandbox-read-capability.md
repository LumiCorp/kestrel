---
id: tavily-sandbox-read-capability
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-22
depends_on:
  - ./0003-confined-docker-capability-transport.md
  - ../../src/kestrel/contracts/sandbox-capability.ts
  - ../../src/code/CodeExecutionService.ts
---

# Tavily Sandbox Read Capability

## Decision

The first authenticated sandbox capability is the exact `tavily.search.read` contract. A resolved code-mode profile authors its operation, resource, audience, request, response, timeout, expiry, and broker-authority ceilings. The model can select only that capability ID and provide its bounded query and result count.

The prepared tool-call boundary adds the exact call ID to trusted tool context. Before Docker creation, the code-execution boundary binds the selected profile contract to tenant, environment, session, run, tool call, profile fingerprint, execution-boundary revision, broker authority, expiry, and the server-side `tool.tavily.default` credential snapshot. Missing or divergent authority fails before Docker or provider use.

The Tavily adapter uses only `https://api.tavily.com/search`, disables redirects, bounds time and response bytes, and normalizes a small secret-free result. It does not accept a base URL, proxy, destination, adapter name, credential reference, identity, approval, budget, revision, or lease from model input. Provider credentials stay in the trusted host runtime and are registered with execution-boundary redaction before use.

The Docker broker remains route-free. After it validates the exact loopback workload request, it writes that request into broker-only tmpfs and waits. A trusted host pump reads the request with `docker exec`, invokes the fixed Tavily adapter once, and writes the bounded normalized response back through `docker exec` stdin. The workload never receives provider routing or a bearer credential. The short-lived opaque lease is only broker bootstrap authority; the broker consumes and deletes it, enforces one accepted request and expiry, and retains the #412 shared-loopback confinement. This slice does not add discovery, external-effect operations, unrestricted fallback, or durable lease recovery.

## Runtime configuration

The trusted runtime snapshot requires exact non-secret identity and revision variables: `KESTREL_TENANT_ID`, `KESTREL_ENVIRONMENT_ID`, `KESTREL_SANDBOX_BROKER_AUTHORITY_ID`, `KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION`, and `KESTREL_TAVILY_CREDENTIAL_REVISION`. The Tavily key remains in the existing secret-bearing internet environment. Absence of any value disables capability resolution without changing capability-free `code.execute`.
