---
id: confined-docker-capability-transport
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-22
depends_on:
  - ../../src/code/DockerSandboxExecutor.ts
  - ../../src/code/contracts.ts
  - ../../tests/process/docker-sandbox.process.test.ts
---

# Confined Docker Capability Transport

## Decision

A capability-enabled `code.execute` workload uses a shared Linux network namespace with one trusted broker container. The broker starts with Docker `--network none`. The workload joins that exact namespace with `--network container:<broker>` and can reach the broker only through a fixed loopback endpoint. Neither container uses Docker bridge or host networking. The broker has no upstream route and cannot forward arbitrary URLs.

The trusted runtime passes a short-lived grant to the broker through `docker exec --interactive` standard input. The broker reads the grant into broker-only tmpfs, loads it into memory, and deletes the file before it becomes ready. The grant never enters the workload request, generated code, arguments, environment, filesystem, diagnostics, replay input, or retained artifacts. The workload does not receive a bearer value. Membership in the broker's isolated network namespace is its request authority. The bootstrap lease authorizes the broker configuration and remains unavailable to the workload, which has a separate mount namespace.

The stub accepts one fixed HTTP path and one exact operation and destination pair. It rejects extra fields, other paths, operations, and destinations. This proof is secret-free and has no provider route.

Capability-free execution always uses `--network none`. A request for ordinary `network:on` is rejected before container creation because unrestricted bridge networking is not an allowed fallback. Capability execution also fails before container creation unless Docker reports a Linux container backend, which owns `container:<name>` network namespace semantics. Kestrel does not fall back to bridge, host networking, a host shell, or direct provider access.

## Backend assumptions

The active Docker daemon must run Linux containers and support joining another running container's network namespace through `--network container:<name>`. This includes a Linux Docker Engine and Docker Desktop while it runs Linux containers. Windows-container mode and non-Docker executors are unsupported by this transport and fail closed.

The broker image is the same locally available `node:20-alpine` image already required by the JavaScript Docker process proof. This decision does not define production broker discovery, provider credentials, capability profiles, durable leases, or adapter behavior.

## Consequences

- The sandbox can reach the exact local stub without gaining an external route.
- The workload and broker share only a network namespace. They do not share process, mount, environment, or filesystem state.
- A compromised workload can scan loopback, but only the fixed stub listener exists there.
- Adding a real broker route or provider adapter requires a later architecture decision and new confinement evidence.
