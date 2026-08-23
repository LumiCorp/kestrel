# Complete Deployment Lifecycle Qualification

Status: open

## Observed gap

The Local Core and hosted-runner production entrypoints now both prove a live authenticated sandbox capability through immutable profile resolution, explicit execution-policy admission, real Docker confinement, and an isolated provider fixture. They expose secret-free completed `code.execute` output and durable capability replay evidence.

The public Execution Protocol does not currently expose an operation that addresses and returns an existing exact effect result after process restart. Reissuing `run.start` creates a new run, call identity, and capability authorization attempt. With credentials and Docker intentionally unavailable after restart, that attempt fails before exact-result lookup. It is not recorded replay and must not be presented as such.

The deployment suites also do not yet exercise cancellation, timeout, expiry, selected-but-unused authority, and operator lifecycle projection in both production forms. Those contracts have shared runtime, Docker process, memory-store, and PostgreSQL coverage, but that evidence is not equivalent to deployment-form qualification.

## Owning surfaces

- Exact recorded-result addressing and replay: Execution Protocol and effect replay boundary.
- Deployment lifecycle assertions: spawned Local Core and hosted-runner qualification harnesses.
- Operator projection: replay/inspection protocol response sourced from the durable capability ledger.

Do not repair this by rerunning `run.start`, minting replacement authority, resolving a fresh credential, contacting the provider, or starting Docker.

## Completion criteria

1. Define a strict public recorded-result lookup/replay operation keyed by existing immutable run/effect identity, or document and approve a different existing public operation that already owns that contract.
2. After process restart, return the exact committed `AgentToolResult` with credential, provider, broker, and Docker spies all remaining at zero.
3. Missing, incomplete, conflicting, or provider-only evidence fails closed without live fallback.
4. Run the same restart proof through spawned Local Core and hosted-runner production entrypoints using persistent stores.
5. Add deployment-form cancellation, timeout/expiry, selected-unused, lifecycle projection, cleanup, and recursive secret-absence assertions.
6. Only after those proofs pass, update the Agent Harness control-038 evidence and score.

## Existing evidence that must remain green

- Shared adapter conformance and external-effect approval tests.
- Docker confinement and lifecycle process tests.
- In-memory and PostgreSQL lease/result atomicity tests.
- Spawned Local Core and hosted-runner live provider-used qualification tests.

This file is a temporary backlog artifact and should be deleted after the completion criteria are satisfied.
