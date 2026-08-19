---
id: kubernetes-byoc-slice-3
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
  - Slice-2.md
---

# Slice 3: Connector Installation, Trust, And Qualification

## Outcome And User-Visible Result

An organization administrator can install a digest-pinned Kestrel connector into a customer cluster, verify and approve its identity, configure the cluster profile, rotate or revoke its access, and run read-only plus disposable active qualification. Kestrel never needs inbound access to the Kubernetes API.

A connection reaches `ready` only after its declared edge, storage, snapshot, network, quota, image, DNS, and TLS behavior is demonstrated. Certified GKE/EKS profiles and qualified non-reference clusters are visibly distinct.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slice 1 defines the Kubernetes profile, connector envelopes, evidence, and support states. Slice 2 provides connection, enrollment, nonce, presence, command, lease, and event persistence plus a Kubernetes connector proxy placeholder.

The repository already contains a proven connector pattern in `apps/web/lib/environments/desktop.ts`: short-lived enrollment, administrator fingerprint approval, Ed25519 request signing, bearer credential rotation, timestamp and nonce replay protection, presence, durable command claims, leases, ordered events, and completion. Extract shared cryptographic and lease utilities without coupling infrastructure commands to Desktop command tables or changing Desktop behavior.

This slice owns the connector process, image, Helm chart, enrollment and runtime APIs, authentication, version negotiation, connection configuration, and qualification. It does not implement tenant Environment lifecycle resources beyond disposable qualification fixtures.

## Locked Architectural Decisions

- The connector opens outbound HTTPS requests to Kestrel; Kestrel never dials the cluster.
- The chart installs into `kestrel-system` and defaults to two active replicas.
- A Kubernetes Lease selects one replica for enrollment and credential rotation; durable database claims distribute commands across replicas.
- Connector upgrades are manual Helm operations pinned to immutable chart and image digests.
- Enrollment starts from a connector-generated request and administrator-verified fingerprint; no bootstrap secret is embedded in Helm values or history.
- Connections explicitly select `gateway_api` or `ingress`. Automatic controller selection and fallback are forbidden.
- Active qualification is an explicit administrator write action and always uses a disposable, uniquely labeled namespace.
- Passing non-reference clusters become `qualified`; only the two declared reference profiles become `certified`.
- Encryption remains attested, even when all behavioral qualification succeeds.

## Public Contracts, Schemas, And Wire Formats

Add `apps/kubernetes-connector` as a Node.js workspace application with a process entrypoint, health endpoint, Kubernetes REST client, enrollment client, command loop, strict contract parsers, and structured redacted logging. Add its Dockerfile and release check beside the existing runtime images.

Add a Helm chart under `deploy/kubernetes/kestrel-connector` with:

- namespace, ServiceAccount, ConfigMap, shared identity Secret, Lease, Deployment, PodDisruptionBudget, and topology spread;
- one bootstrap ClusterRole for Kestrel namespace lifecycle and binding the predefined Environment-manager role;
- one Environment-manager ClusterRole containing the fixed mutation allowlist plus namespace-bound `get`/`list` access across namespaced resources so deletion can discover customer CRDs and fail closed;
- digest-only image configuration;
- Kestrel base URL, connector display name, and optional outbound proxy configuration;
- CPU/memory requests and Restricted-compatible security contexts; and
- no Kubernetes API credentials outside the in-cluster ServiceAccount projection.

The connector disables ServiceAccount token automount on runtime workloads, but its own Pod mounts a projected, rotating ServiceAccount token because it is the Kubernetes API client.

Introduce administrator APIs:

- `GET /api/organization/infrastructure/kubernetes/enrollments/[id]`
- `POST /api/organization/infrastructure/kubernetes/enrollments/[id]/approve`
- `POST /api/organization/infrastructure/kubernetes/connections/[id]/configure`
- `POST /api/organization/infrastructure/kubernetes/connections/[id]/qualify`
- `POST /api/organization/infrastructure/kubernetes/connections/[id]/revoke`
- `GET /api/organization/infrastructure/kubernetes/connections/[id]`

Introduce connector-authenticated runtime APIs:

- `POST /api/runtime/infrastructure-connectors/enrollments`
- `GET /api/runtime/infrastructure-connectors/enrollments/[id]`
- `POST /api/runtime/infrastructure-connectors/[connectionId]/presence`
- `POST /api/runtime/infrastructure-connectors/[connectionId]/commands/claim`
- `POST /api/runtime/infrastructure-connectors/[connectionId]/commands/[commandId]/lease`
- `POST /api/runtime/infrastructure-connectors/[connectionId]/commands/[commandId]/events`
- `POST /api/runtime/infrastructure-connectors/[connectionId]/commands/[commandId]/complete`

Enrollment creation accepts connector name, Ed25519 signing public key, credential-envelope encryption public key, connector contract versions, and non-authoritative cluster metadata. It returns request ID, one-time request secret, fingerprint, expiry, and verification path. The connector stores the request secret in its shared Secret and logs only the verification path and fingerprint.

Approval binds the enrollment to one organization and creates the Slice 2 provider connection. Consumption returns connection ID, organization ID, rotating connector bearer credential, Kestrel ticket public key, and supported contract window encrypted to the connector public key where appropriate.

Every authenticated request includes bearer credential, timestamp, nonce, and Ed25519 signature over method, exact path, timestamp, nonce, and SHA-256 body digest. Reuse the Desktop skew, nonce lifetime, credential rotation interval, previous-credential grace, and command lease constants unless a focused test demonstrates infrastructure-specific need.

`KubernetesConnectionConfigV1` contains:

- display name and optional default status;
- namespace prefix and required base domain;
- explicit edge union from Slice 1;
- exact edge-controller namespace and Pod selectors used in NetworkPolicy;
- StorageClass and VolumeSnapshotClass names;
- optional source pull-secret name in `kestrel-system`;
- required positive attestations for volume encryption and Secret-at-rest encryption, with actor, timestamp, and evidence note;
- selected reference profile ID or `non_reference`; and
- runtime template allowlist supported on this connection.

Qualification results contain one result per check with status `passed`, `failed`, `blocked`, or `not_run`, evidence class, observed version/driver/controller detail, sanitized Kubernetes conditions, request or audit IDs when available, cleanup result, and expiration. A configuration change invalidates prior qualification.

## Ordered Implementation Phases

1. Extract shared connector request-authentication, enrollment-key, nonce, credential-rotation, claim-token, and lease helpers with unchanged Desktop tests.
2. Scaffold and package the connector process with strict startup configuration, health, redaction, graceful shutdown, and contract-version reporting.
3. Add the Helm chart, RBAC boundary tests, two-replica deployment, leader Lease, shared Secret coordination, and digest enforcement.
4. Implement connector-generated enrollment, administrator approval, enrollment consumption, Secret persistence, restart recovery, and revocation.
5. Implement presence and version negotiation. Presence is sent every 30 seconds; a connection is degraded after two minutes without presence, but queued commands are retained.
6. Implement claim, 90-second lease renewal, ordered event upload, completion, resume IDs, and cancellation. The command loop renews leases at no more than one-third of the lease interval.
7. Move the Slice 1 Kubernetes discovery client into connector ownership and expose `qualification.inspect` through the command protocol.
8. Implement `qualification.execute` as the active, administrator-approved state machine.
9. Add the minimal administration surface required to approve, configure, qualify, inspect, and revoke connections. Full Environment creation remains disabled until Slice 6.
10. Add chart/image release metadata and compatibility diagnostics without automatic publication or cluster upgrade.

## Data Flow And Lifecycle Behavior

On first start, the leader replica creates the shared identity Secret using create-if-absent semantics, generates signing and encryption keys if missing, creates an enrollment request, and persists its request identity. Both replicas wait until an administrator approves the displayed fingerprint. The leader consumes approval and stores the rotating credential. Subsequent requests can come from either replica using the shared identity.

Presence updates connector and cluster facts but cannot grant certification. The server compares advertised command versions with its supported window before making commands claimable.

Read-only qualification performs version discovery, exact API-resource verb discovery, exact `SelfSubjectAccessReview` calls, named class reads, CSI driver matching, declared edge reads, namespace-creation authorization, and connector RBAC self-checks.

Active qualification creates `kestrel-qualification-<short-id>` with expiry labels, then executes in order:

1. apply Restricted labels, quota, limits, ServiceAccounts, and baseline policies;
2. schedule a Kestrel probe image and verify digest plus readiness;
3. create a `ReadWriteOnce` PVC, read it back and require exact `spec.accessModes: [ReadWriteOnce]`, write a nonce, foreground-delete the probe Deployment, wait for Deployment absence and an empty exact-label Pod list, recreate one probe Pod, and read the nonce;
4. create a VolumeSnapshot, wait for `readyToUse`, restore a new PVC, and read the nonce;
5. create a probe Service and edge route for a unique hostname;
6. verify public DNS, TLS, and signed health from Kestrel;
7. prove the permitted edge-to-probe and gateway-to-workspace paths;
8. prove direct and cross-namespace access fail under NetworkPolicy;
9. attempt one request beyond the disposable quota and prove rejection; and
10. remove the namespace and verify all namespaced resources disappear while shared customer prerequisites remain.

Any failed or blocked step marks later dependent steps `not_run`. Cleanup always runs. Residual resources force `degraded`, even if capability checks passed.

## Security And Trust Boundaries

- The connector's Kubernetes rights are limited to the installed resource kinds. Namespace name and ownership labels are validated before every mutation.
- Binding is limited to the predefined Environment-manager ClusterRole; arbitrary Role or ClusterRole binding is rejected.
- Connector private keys and bearer credentials live only in the cluster Secret. The server stores public keys and credential hashes.
- Request nonces and timestamps prevent replay; signatures bind method, path, and body.
- The request secret is one-time, expires with enrollment, and is never an ongoing credential.
- Qualification secrets are random, short-lived, encrypted in queue payloads, and deleted with the fixture namespace.
- Server logs and command events redact bearer values, Secret data, pull-secret data, certificate private keys, and encrypted-envelope plaintext.
- Customer selectors, classes, Gateway references, and domains are parsed data, never interpolated into shell commands.

## Failure, Retry, Recovery, And Rollback Behavior

If both replicas race enrollment, Kubernetes Lease and create-if-absent Secret semantics select one identity. Restart resumes the stored request or active connection; it never creates a second approved identity.

Previous connector credentials remain accepted only during the existing short rotation grace. A replica that misses rotation reloads the shared Secret before grace expires. Signature or replay failure never falls back to bearer-only authentication.

An offline connector leaves commands queued. A claimed command becomes available after lease expiry and is reclaimed with the same idempotency key. Connector command handlers must inspect current cluster state before repeating work.

Interrupted qualification resumes from persisted command events and observed resources when ownership matches. Otherwise it performs cleanup and requires a new explicit run. Expired qualification is never silently reused after configuration, connector, cluster, class, driver, or edge changes.

Revocation cancels queued commands, refuses new claims, invalidates credentials, and leaves cluster resources unchanged pending explicit Environment cleanup. Helm uninstall is not a revocation substitute.

Rollback disables new enrollments and qualification routes, revokes test connections, and manually uninstalls the chart only after its qualification namespace is confirmed absent. Slice 2 records remain for audit.

## Detailed Test Matrix

- Two replicas converge on one enrollment identity and one credential Secret.
- Enrollment expiry, approval race, repeated consumption, wrong fingerprint, wrong organization, and revocation.
- Current and grace credentials, expired previous credential, invalid signature, wrong path/body digest, skew, nonce replay, and cross-connection request.
- Presence rotation, shared Secret reload, connector restart, stale/degraded thresholds, and supported-version overlap.
- Concurrent claim, lease renewal, lease loss, reclaim, ordered events, duplicate replay, cancellation, and completion.
- Helm rendering, digest-only image, Restricted security context, RBAC resource/verb allowlist, forbidden wildcard verbs, topology spread, and disruption budget.
- Read-only discovery for missing API, missing verb, denied verb, missing class, CSI mismatch, and path-prefixed API server.
- Active qualifier success and failure at every ordered step.
- Exact `ReadWriteOnce` probe and restored-PVC manifests and live API readback; missing, malformed, mixed, or wrong observed modes fail the owning check.
- Probe recreation occurs only after foreground Deployment deletion and an empty `app=probe` Pod list; a lingering Pod fails qualification while cleanup still runs.
- NetworkPolicy positive and negative probes, quota rejection, public TLS/DNS failure, snapshot pending, restore mismatch, and cleanup residual.
- Certified profile match, non-reference qualified result, expired evidence, and configuration invalidation.
- Logs, API responses, events, and database rows contain no connector or Kubernetes Secret plaintext.

## Validation Commands And Proof Artifacts

- Run focused Desktop connector regression tests and new connector contract/auth/queue tests.
- Run the process validation leaf for the connector process boundary.
- Run the Postgres validation leaf for enrollment, claim, and lease concurrency.
- Render and lint Helm with both edge profiles and scan rendered RBAC for unexpected wildcards.
- Build the connector image and run startup, shutdown, and non-root smoke tests.
- Run `pnpm run check:public-boundary` and `pnpm validate` before the slice PR is ready.
- Save qualification JSON with evidence class, step results, observed prerequisites, API-read `ReadWriteOnce` modes for both probe PVCs, and cleanup inventory. This is isolated-provider evidence only when run against a real cluster.

## Exit Criteria

- A fresh chart install produces one administrator-verifiable connector identity across two replicas.
- Authentication, replay protection, rotation, presence, claim, lease, events, and completion pass failure tests.
- A ready connection has current read-only and active qualification plus required attestations.
- GKE and EKS reference test clusters complete qualification with their declared edge modes.
- Failed or interrupted qualification leaves no unlabeled or unreported resources.
- Kestrel stores no kubeconfig, Kubernetes bearer token, or connector private key.

## Explicit Exclusions And Handoff

This slice does not create tenant Environments, workspaces, backups, execution tickets, or previews. It does not publish or automatically upgrade production connector artifacts. Slice 4 implements every provider-neutral lifecycle operation through the qualified connector command path.
