---
id: tavily-sandbox-read-capability
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-22
depends_on:
  - ./0003-confined-docker-capability-transport.md
  - ../../src/kestrel/contracts/sandbox-capability.ts
  - ../../src/code/SandboxCapabilityAdapterRegistry.ts
  - ../../src/code/CodeExecutionService.ts
---

# Authenticated Sandbox Capability Adapters

## Decision

The first authenticated sandbox capability is the exact `tavily.search.read` contract. It now implements the versioned sandbox-capability adapter contract rather than defining a Tavily-only runtime boundary. A closed host registry accepts only explicitly registered adapter IDs and exact operation, resource, credential kind, and effect classification. It performs no discovery, ranking, destination selection, or fallback. Legacy V1 Tavily evidence remains parseable and replayable; newly authored and issued capabilities use the generic V2 contract.

A resolved code-mode profile authors the capability operation, resource, audience, adapter configuration, request and response ceilings, timeout, expiry, and broker authority. The model can select only an authored capability ID and supply the adapter's strictly parsed bounded input. The adapter—not model input or profile heuristics—declares whether the operation is `read_only` or `external_effect`. An external-effect adapter additionally requires the exact current action-bound approval and effect idempotency binding before credential resolution or lease issuance.

The prepared tool-call boundary adds the exact call ID to trusted tool context. Before Docker creation, the code-execution boundary binds the selected profile contract to tenant, environment, session, run, tool call, profile fingerprint, execution-boundary revision, broker authority, expiry, and the server-side `tool.tavily.default` credential snapshot. Missing or divergent authority fails before Docker or provider use.

The Tavily adapter uses only `https://api.tavily.com/search`, disables redirects, bounds time and response bytes, and normalizes a small secret-free result. It does not accept a base URL, proxy, destination, adapter name, credential reference, identity, approval, budget, revision, or lease from model input. Provider credentials stay in the trusted host runtime and are registered with execution-boundary redaction before use. Every production-registered adapter must pass the same exactness, ceiling, redirect, error-redaction, consumption-order, and teardown conformance harness.

The Docker broker remains route-free. After it validates the exact loopback workload request, it writes that request into broker-only tmpfs and waits. A trusted host pump reads the request with `docker exec`, invokes the selected registered adapter once, and writes the bounded normalized response back through `docker exec` stdin. The workload never receives provider routing or a bearer credential. The short-lived opaque lease is only broker bootstrap authority; the broker consumes and deletes it, enforces the durable lease's exact request and response ceilings and expiry, and retains the #412 shared-loopback confinement.

The durable lease coordinator owns authorization and consumption truth. Its secret-free binding records the adapter ID, effect classification, operation, resource, identity, policy and approval authority, credential reference and revision, ceilings, and replay evidence. Provider contact is preceded by an atomic invocation transition; exact completed tool results are persisted before capability cleanup and container removal. Recovery replays only a committed exact result and never substitutes a fresh provider call. Ambiguous provider invocation fails closed. Child capability use requires an independently approved, atomically reserved allocation rather than inheriting a parent token.

The adapter contract does not permit unrestricted network fallback. The route-free Docker transport and durable lifecycle are shared infrastructure, but each adapter remains responsible for one canonical input and one fixed trusted-host provider boundary.

## Runtime configuration

The trusted runtime snapshot requires exact non-secret tenant, environment, broker-authority, and credential-revision evidence. Local Core resolves these values from its runtime environment and credential store; the hosted runner resolves them from host-owned configuration. The Tavily key remains host-side and is resolved per selected call. Missing or stale authority fails before provider use and does not change capability-free `code.execute`.
