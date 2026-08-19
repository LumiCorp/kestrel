---
id: completing-kubernetes-byoc
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../ARCHITECTURE.md
  - ../../DESIGN.md
  - ../../RELIABILITY.md
  - ../../SECURITY.md
---

# Completing Kubernetes BYOC Accurately

## Question

What will it take to completely and accurately complete Kestrel's BYOC feature, with Kubernetes as the standardized environment adapter?

## Answer

Completing BYOC is a provider-neutral control-plane initiative, not the completion of one Kubernetes client. The current branch establishes a useful admission layer: it defines required capabilities, discovers Kubernetes APIs, checks exact permissions with `SelfSubjectAccessReview`, and validates configured ingress, storage, and snapshot classes. It does **not** yet provision, route to, operate, reconcile, meter, expose, or prove a Kubernetes-backed Kestrel Environment.

The complete feature needs seven dependency-ordered slices:

1. Settle the Kubernetes compatibility profile and the provider-neutral resource contract.
2. Migrate persistence and lifecycle state away from Fly-specific identities.
3. Add a secure Kubernetes connection lifecycle and retain the current preflight as admission evidence.
4. Implement the full, idempotent Kubernetes lifecycle adapter.
5. Make execution, gateway, preview, and authorization routing provider-neutral.
6. Wire every control-plane and product surface through provider selection.
7. Prove isolation, persistence, recovery, replacement, routing, and cleanup on real clusters before a manually gated pilot.

This is necessarily a multi-PR initiative. A correct implementation touches contracts, schema and migrations, credentials, provider resources, runtime routing, previews, backups, reconciliation, observability, costs, UI, security, and provider-isolated verification. Calling the feature complete before those paths converge would be inaccurate even if the Kubernetes adapter itself compiled and passed unit tests.

## Definition of Complete

Kubernetes BYOC is complete only when an authorized organization administrator can:

- configure and rotate a supported Kubernetes connection without exposing credentials to the browser;
- receive an exact, actionable readiness result for APIs, permissions, controllers, classes, policies, reachability, and Kestrel image access;
- create a Kubernetes-backed Environment and have Kestrel durably record provider-neutral resource identities;
- provision a gateway and workspaces, execute tasks, publish previews, stop and restart workspaces without losing data, update immutable runtime images, take and restore backups, replace failed resources, and delete everything without orphans;
- see provider-native conditions and request identifiers in health and audit evidence;
- rely on namespace and network isolation that has been demonstrated against the cluster's actual CNI, not merely inferred from API discovery; and
- complete the same isolated-provider acceptance story already required of Fly: gateway-only ingress, signed private routing, cross-environment isolation, stop/start persistence, replacement-volume backup/restore, idempotent ensure behavior, and confirmed cleanup.

The evidence must remain explicitly classified as unit or mock, hermetic state-machine, isolated-provider, pilot, or production. A fake API server is not end-to-end proof, and a successful admission preflight is not proof that controllers enforce the declared resources.

## Current State

### What the branch establishes

- [`providers/contracts.ts`](../../apps/web/lib/environments/providers/contracts.ts) defines a capability descriptor and a compatibility assertion.
- [`providers/kubernetes-byoc.ts`](../../apps/web/lib/environments/providers/kubernetes-byoc.ts) performs read-only version and API discovery, checks the exact resource verbs Kestrel needs with `SelfSubjectAccessReview`, preserves an API server path prefix, and verifies explicitly named `IngressClass`, `StorageClass`, and `VolumeSnapshotClass` resources. It also checks that the storage and snapshot drivers match.
- [`providers/kubernetes-byoc.test.ts`](../../apps/web/lib/environments/providers/kubernetes-byoc.test.ts) proves the discovery and rejection behavior against controlled HTTP responses.
- Fly now publishes the same capability descriptor, so the branch provides the beginning of a shared admission vocabulary.

This is a strong first slice because it rejects unsupported clusters before mutation. Its evidence level is correctly `cluster_preflight`, not provider lifecycle proof.

### What is still Fly-shaped

The alias named `UniversalEnvironmentInfrastructureProvider` currently points directly to `EnvironmentInfrastructureProvider`, whose inputs and outputs are Fly abstractions: `appName`, `machineId`, `volumeId`, Machine state, Fly network identity, shared IP, and Fly-only error codes. The provider contract also asserts `encrypted: true` for every volume. Renaming the interface has not yet made its semantics universal.

The persistence model is similarly provider-specific:

- [`drizzle/schema.ts`](../../apps/web/drizzle/schema.ts) allows only `fly` or `desktop` Environments and stores `flyAppName`, `flyNetworkName`, `flyGatewayMachineId`, `flyMachineId`, and `flyVolumeId`.
- [`environments/contracts.ts`](../../apps/web/lib/environments/contracts.ts) accepts only `provider: "fly"` and validates Fly regions.
- [`organization-infrastructure-settings.ts`](../../apps/web/lib/environments/organization-infrastructure-settings.ts) applies Fly's region catalog to organization infrastructure policy.
- [`provisioner.ts`](../../apps/web/lib/environments/provisioner.ts) checkpoints, rolls back, retries, and records evidence using those Fly identities and Fly-only errors.
- [`fly-connection.ts`](../../apps/web/lib/environments/fly-connection.ts) owns the only hosted-environment connection lifecycle.

Runtime contracts also encode Fly topology:

- [`packages/environment-auth/src/index.ts`](../../packages/environment-auth/src/index.ts) issues Fly or Desktop execution targets and places Fly app and Machine IDs in tickets.
- [`apps/environment-router/src/router.ts`](../../apps/environment-router/src/router.ts) resolves workspaces as `<machine>.vm.<app>.internal`.
- [`apps/environment-router/src/preview-relay.ts`](../../apps/environment-router/src/preview-relay.ts), [`apps/web/lib/environments/gateway-config.ts`](../../apps/web/lib/environments/gateway-config.ts), [`apps/web/lib/environments/execution-route.ts`](../../apps/web/lib/environments/execution-route.ts), and [`apps/preview-edge/src/route-resolver.ts`](../../apps/preview-edge/src/route-resolver.ts) carry the same assumptions into signed execution and preview routing.

Backups, reconciliation, deletion, systems inventory, and cost metering instantiate or interpret Fly directly. These are not peripheral cleanups: they are part of the durable environment lifecycle.

## Required Work

### 1. Freeze a supported Kubernetes compatibility profile

Before adding mutations, make the product's support boundary explicit and versioned. At minimum it must decide:

- minimum Kubernetes API compatibility and the versions Kestrel tests;
- whether the first public gateway contract uses Ingress, Gateway API, or a deliberately limited choice;
- supported authentication modes: static bearer token, client certificate, OIDC or cloud-issued short-lived credentials, and whether exec-based kubeconfigs are prohibited;
- direct control-plane reachability requirements for private clusters, including DNS, proxies, and custom certificate authorities;
- one namespace per Kestrel Environment versus a pre-created shared namespace model;
- required ingress or gateway controller behavior, TLS and DNS ownership, wildcard versus per-environment hostnames, and health semantics;
- StorageClass requirements, PVC access mode, binding mode, expansion behavior, reclaim behavior, and snapshot driver compatibility;
- CNI NetworkPolicy enforcement, Pod Security Standards compatibility, quota requirements, and allowed egress;
- image registry reachability and the image-pull credential model;
- topology policy when standard region or zone labels are absent or untrustworthy; and
- what Kestrel can honestly attest about volume encryption and Kubernetes Secret encryption.

Kubernetes documents that creating an Ingress has no effect without an ingress controller and that the Ingress API is frozen in favor of Gateway API. Therefore discovery of `networking.k8s.io/v1` and an `IngressClass` is necessary but not sufficient evidence of a public gateway ([Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)).

Likewise, the VolumeSnapshot APIs are CRDs, work only with CSI drivers, and depend on snapshot controller and driver support. Class existence and driver matching do not prove that a snapshot will become usable ([Volume snapshots](https://kubernetes.io/docs/concepts/storage/volume-snapshots/), [VolumeSnapshotClass](https://kubernetes.io/docs/concepts/storage/volume-snapshot-classes/)).

Two contract decisions are blockers:

1. **Encryption:** Kubernetes API-object encryption and workload-volume encryption are separate. Kubernetes says mounted filesystem encryption requires an encrypted storage integration or application-layer encryption. A universal adapter cannot derive `encrypted: true` from standard `StorageClass` metadata ([Encrypting confidential data at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)). Kestrel must either require provider-specific attestation for an approved class or replace the unconditional Boolean with explicit, evidenced security posture.
2. **Location:** Kubernetes topology labels may be absent or provider-specific. The provider contract should express requested and observed placement without pretending every cluster has a Fly-like region catalog.

### 2. Make the domain model provider-neutral

Do this before implementing Kubernetes lifecycle methods so the new provider does not translate Kubernetes resources into misleading Fly fields.

The durable model needs:

- `kubernetes` in the Environment provider enum and validation contracts;
- an Environment connection reference and versioned provider configuration;
- provider-neutral resource references for Environment scope, gateway, workspace compute, workspace storage, and snapshots;
- provider-native metadata held in a typed provider payload rather than new top-level columns for every Kubernetes resource;
- a provider-neutral error taxonomy such as unavailable, rejected, conflict, invalid response, unhealthy, unsupported, and timeout, while preserving the native provider code and Kubernetes request UID as evidence;
- provider-neutral requested and observed placement;
- migrations and backfills that preserve every existing Fly identity and replay invariant;
- uniqueness and ownership constraints for active resources; and
- updated Postgres tests for lifecycle checkpoints, rollback, replacement, deletion, and recovery.

The resource reference should be stable across provider replacement. For Kubernetes, a workspace's identity should be a logical name and provider-qualified object references, not a Pod UID. Pods are replaceable; the stable routing and storage objects are Services, StatefulSets, and PVCs.

The provider contract should then be recast around Kestrel concepts: Environment scope, gateway workload, workspace workload, persistent workspace store, snapshot, and inventory. Fly and Kubernetes adapters can translate those concepts into provider-native resources. The existing lifecycle and rollback semantics in [`provisioner.ts`](../../apps/web/lib/environments/provisioner.ts) should remain the owner of orchestration; the adapter should own provider mutations and observations.

### 3. Build a secure connection and admission lifecycle

Add a Kubernetes connection service analogous to Fly's, but do not accept arbitrary kubeconfig behavior by default.

It must support:

- encrypted-at-rest connection material, server URL, CA bundle, authentication material, namespace policy, controller or class choices, and optional proxy settings;
- configure, test, rotate, disable, and revoke operations;
- trusted-server-only decryption and redacted audit output;
- explicit TLS validation, URL parsing, path-prefix preservation, redirect policy, response-size limits, timeouts, and sanitized provider errors;
- SSRF controls appropriate to a feature intentionally connecting to customer-supplied private endpoints;
- a credential mode Kestrel can rotate operationally; and
- a preflight result that separates unsupported API, missing verb, denied verb, missing class, controller not ready, failed test PVC, failed test snapshot, failed image pull, failed gateway reachability, and unenforced isolation.

The current static bearer-token input is useful for initial tests but should not be the only production connection mode. Kubernetes recommends short-lived TokenRequest tokens or other protected external authentication over long-lived ServiceAccount token Secrets ([Service Accounts](https://kubernetes.io/docs/concepts/security/service-accounts/)). Exec-based kubeconfig authentication can launch local executables; accepting arbitrary kubeconfig from a customer would expand the control-plane execution boundary and should be prohibited or separately sandboxed ([kubeconfig API](https://kubernetes.io/docs/reference/config-api/kubeconfig.v1/)).

Admission should have two phases:

1. **Read-only compatibility:** retain the branch's API discovery, exact authorization checks, and class validation.
2. **Disposable behavioral qualification:** with explicit admin approval, create labeled test resources to prove scheduling, image pulling, PVC binding, snapshot readiness, controller reconciliation, ingress or gateway reachability, NetworkPolicy enforcement, and cleanup.

### 4. Implement the Kubernetes lifecycle adapter

The adapter must implement the whole Environment provider contract, not only create paths.

#### Environment scope

- Create or adopt a namespace according to the selected ownership model.
- Apply Kestrel labels, annotations, and a provider-state version to every managed object.
- Configure service accounts, least-privilege Roles and RoleBindings, ResourceQuota, LimitRange, Pod Security labels, registry credentials, and default-deny NetworkPolicies.
- Record enough ownership evidence to distinguish Kestrel-managed resources from customer-managed prerequisites.

#### Gateway

- Reconcile a Deployment, stable ClusterIP Service, configuration and service-token Secret, health probes, and an Ingress or Gateway API route.
- Wait on Deployment availability, Service endpoints, controller status, TLS readiness, and an external signed health check.
- Return a provider-neutral public route rather than synthesizing `.fly.dev`.

#### Workspace

- Reconcile a StatefulSet or an equivalent stable workload controller, stable Service, PVC, runtime configuration, resource requests and limits, probes, graceful termination, and `automountServiceAccountToken: false` unless the runtime demonstrably needs Kubernetes API access.
- Map stop and start to an idempotent desired replica count while preserving the PVC.
- Resolve the running Pod only for health and evidence; do not make its UID the workspace identity.
- Use immutable image digests, detect rollout failure, and retain rollback evidence.

StatefulSets provide sticky identities and stable storage but also have rollout and deletion behavior that must be handled explicitly; scaling down does not delete associated volumes ([StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)). Private images require namespace-scoped pull credentials or a supported credential provider ([Images](https://kubernetes.io/docs/concepts/containers/images/)).

#### Backup and replacement

- Create `VolumeSnapshot` resources and wait for `readyToUse` with bounded, observable retries.
- Restore into a new PVC using the snapshot as `dataSource`.
- Implement replacement workspace creation, health verification, route cutover, old-resource retirement, and rollback.
- Preserve Kestrel retention semantics without deleting customer-owned classes or drivers.

#### Reconciliation and deletion

- List resources by exact Kestrel labels and verify ownership before mutation.
- Reconcile partial creates and updates after control-plane restarts.
- Handle API conflicts, throttling, stale `resourceVersion`, finalizers, evictions, unavailable nodes, and namespaces stuck terminating.
- Delete in a deterministic order, wait for actual disappearance, report residual resources, and never remove customer-managed prerequisites.

Use server-side apply with a dedicated field manager where ownership is clear. Kubernetes tracks field ownership and reports conflicts; the adapter must not force ownership over customer-managed fields without an explicit adoption contract ([Server-side apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)). Owner references and finalizers must be designed deliberately because Kubernetes garbage collection follows them and cross-scope ownership is constrained ([Garbage collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/), [Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)).

### 5. Make runtime routing provider-neutral

Add a Kubernetes execution target to the shared signed-ticket contracts and every consumer. It should carry a stable, validated route such as a workspace Service identity scoped to the Environment namespace, not arbitrary customer-supplied URLs and not Fly fields.

Required consumers include:

- environment authorization issuance and renewal;
- Environment Router execution, app relay, model relay, and preview relay;
- gateway configuration generation and refresh;
- Preview Edge tickets and route resolution;
- Web execution-route construction;
- workspace-runtime preview publication; and
- tests that reject provider-field confusion or cross-environment routing.

The Kubernetes network path also needs an explicit deployment topology. If Environment Router runs in the customer cluster, Kestrel must deploy, update, and observe it. If it runs outside, private Service DNS is not reachable and the design needs a secure tunnel or gateway protocol. This is a product architecture decision, not a provider-client detail.

Kubernetes Services provide the stable address over changing Pods, but NetworkPolicy enforcement depends on the cluster's network plugin. The API can exist while policies have no effect, so isolation requires a real negative-connectivity canary ([Service networking](https://kubernetes.io/docs/concepts/services-networking/service/), [Network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)).

### 6. Wire the complete control plane and product surface

Create one provider registry or factory resolved from the Environment and its connection. Route all lifecycle entry points through it:

- Environment create, update, health, delete, and recovery;
- workspace provision, start, stop, rebuild, replacement, and delete;
- backups and restore;
- scheduled reconciliation and stale-resource inventory;
- organization deletion;
- execution and preview configuration;
- systems map and health detail;
- audit and operation evidence; and
- cost reporting.

The UI and APIs need a manual administration flow for connection setup and qualification, Kubernetes-specific namespace/class/controller settings, provider selection, actionable readiness failures, and explicit lifecycle actions. The current Fly and RunPod manual-delivery boundary should remain: no automatic production promotion or tenant migration is implied by implementing BYOC.

Cost semantics must be honest. Kestrel can inventory requested CPU, memory, and storage, but it generally cannot derive the customer's actual Kubernetes infrastructure cost from the standard API. Report BYOC as customer-billed or cost-unknown unless the organization configures a separate metering integration; do not reuse Fly prices.

### 7. Prove the complete behavior

#### Hermetic evidence

- contract tests showing Fly and Kubernetes implement the same provider-neutral behavior;
- request and response validation for every Kubernetes API boundary;
- idempotent create, resume-after-partial-create, update, delete, and retry state-machine tests;
- conflict, 408, 409, 429, 5xx, invalid JSON, timeout, and stale-object tests;
- migration and Postgres replay tests;
- signed-ticket and route-confusion tests; and
- proof that provider credentials and Kubernetes Secrets never appear in client responses, logs, or provider workload environment evidence.

#### Isolated-provider evidence

Run the disposable canary against more than one supported combination, because a single local cluster cannot prove BYOC portability. The matrix should cover at least:

- two materially different Kubernetes distributions or hosting environments;
- two supported CNI or policy implementations;
- the supported ingress or Gateway API controller contract;
- two compatible CSI or snapshot implementations if Kestrel claims broad CSI portability; and
- a private registry path.

For each matrix member, prove:

1. exact preflight and least-privilege denial reporting;
2. idempotent Environment and workspace creation;
3. only the gateway is externally reachable;
4. signed gateway-to-workspace routing succeeds;
5. direct and cross-Environment routing fails;
6. stop/start preserves workspace data;
7. image update succeeds and a bad rollout rolls back;
8. snapshot, replacement PVC restore, replacement workspace, and cutover preserve data;
9. API restart or Kestrel restart resumes partial operations;
10. pod eviction and node loss recover without changing logical workspace identity;
11. deletion removes every Kestrel-owned object and retains customer-owned prerequisites; and
12. audit evidence contains provider-native conditions and request identifiers.

NetworkPolicy API discovery alone cannot satisfy items 3 and 5: Kubernetes explicitly requires a networking solution that enforces NetworkPolicy, and default pod isolation is open until policy applies ([Network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)).

#### Pilot and production evidence

After hermetic and isolated-provider gates pass, use a manually approved organization and cluster. Keep rollback to Fly or a disabled Environment available, observe it through a bounded pilot, and label pilot evidence separately from production evidence. Do not bulk-migrate existing Environments as part of feature completion.

## Dependency-Ordered Delivery Plan

| Slice | Deliverable | Exit gate |
| --- | --- | --- |
| 0 | Kubernetes compatibility profile and explicit encryption, topology, auth, gateway, namespace, and network decisions | Approved versioned support contract with no claims the API cannot prove |
| 1 | Provider-neutral domain contract, error model, resource references, schema migration, and Fly adapter migration | Existing Fly behavior and replay tests pass without Fly identities in shared orchestration |
| 2 | Kubernetes connection lifecycle and two-phase qualification | Credentials rotate safely; unsupported or unenforced prerequisites fail actionably |
| 3 | Namespace, gateway, workspace, PVC, snapshot, update, replacement, inventory, and deletion adapter | Full hermetic lifecycle and fault tests pass |
| 4 | Provider-neutral execution, authorization, gateway, and preview routing | Signed execution and preview paths pass for Fly, Desktop, and Kubernetes targets |
| 5 | Provisioner, backups, reconcile, deletion, systems map, audit, cost, API, and UI wiring | An admin can complete the entire lifecycle without direct database or kubectl repair |
| 6 | Real-cluster portability, isolation, persistence, recovery, and cleanup matrix | Isolated-provider canary passes on every declared supported profile |
| 7 | Manually gated pilot and runbook | Bounded pilot passes with rollback, observability, and no orphaned resources |

Each slice should be independently reviewable and reversible. Schema and signed-contract migrations require dual-read or versioned compatibility where active workspaces or in-flight tickets may outlive a deployment.

## Principal Risks and Unknowns

### Decisions that must be made before implementation

- Is v1 limited to one known distribution and controller/CSI/CNI profile, or marketed as generic conformant Kubernetes?
- Does Kestrel create namespaces, or operate only in an admin-provisioned namespace?
- Is the public entry contract Ingress, Gateway API, or a Kestrel-managed in-cluster gateway reached through a separate tunnel?
- Which external authentication methods are supportable without executing customer-supplied plugins?
- What exact evidence permits Kestrel to call persistent storage encrypted?
- What egress must workspaces have, and who owns the allowed-destination policy?
- Does Kestrel support clusters whose API server is not reachable from the existing control plane?
- Is actual BYOC cost visibility out of scope, customer-configured, or an integration requirement?

### High-confidence conclusions

- The current branch is an admission/preflight foundation, not an Environment provider.
- Provider-neutral schema and routing are prerequisite work, not follow-up polish.
- Controller behavior, network isolation, storage binding, snapshot readiness, and image pulling require live behavioral qualification.
- A static bearer-token-only connection is too narrow for a broadly portable production BYOC claim.
- Generic Kubernetes does not provide enough standard evidence to assert volume encryption or exact infrastructure cost.
- “Works on Kubernetes” must name and test a compatibility profile; API conformance alone is not an operational support promise.

### Remaining uncertainty

The repository cannot answer customer-cluster decisions that have not yet been made: expected distributions, private connectivity, identity provider, DNS/TLS ownership, storage encryption guarantees, or desired support breadth. Those decisions change the resource implementation and test matrix materially. The safest first product boundary is a narrow, explicitly qualified Kubernetes profile that can expand only after each new combination passes the same isolated-provider canary.

## Implications

The universal adapter should be universal at the Kestrel domain boundary and deliberately provider-native below it. Trying to hide Kubernetes behind Fly's app/Machine vocabulary would produce brittle state, misleading evidence, and provider leaks through every downstream contract. Conversely, adding a large generic plugin framework now is unnecessary: one provider-neutral Kestrel lifecycle contract, one Fly implementation, and one Kubernetes implementation are enough to validate the abstraction.

The immediate next move is Slice 0, followed by Slice 1. Do not begin mutating Kubernetes resources until the encryption, topology, authentication, ingress, namespace, and routing decisions are explicit and the database can persist Kubernetes identities without pretending they are Fly resources.

## Sources

### Repository

- [Environment provider capability delivery plan](../plans/2026-07-17-provider-capability-delivery.md)
- [Architecture](../../ARCHITECTURE.md)
- [Design principles](../../DESIGN.md)
- [Reliability](../../RELIABILITY.md)
- [Security](../../SECURITY.md)
- [Provider contracts](../../apps/web/lib/environments/providers/contracts.ts)
- [Kubernetes BYOC discovery client](../../apps/web/lib/environments/providers/kubernetes-byoc.ts)
- [Environment provisioner](../../apps/web/lib/environments/provisioner.ts)
- [Environment schema](../../apps/web/drizzle/schema.ts)
- [Environment authentication](../../packages/environment-auth/src/index.ts)
- [Environment Router](../../apps/environment-router/src/router.ts)
- [Fly isolated-provider canary](../../apps/web/scripts/environment-fly-canary.ts)

### Kubernetes primary documentation

- [Accessing the Kubernetes API](https://kubernetes.io/docs/tasks/administer-cluster/access-cluster-api/)
- [Service Accounts](https://kubernetes.io/docs/concepts/security/service-accounts/)
- [RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Services](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [Volume snapshots](https://kubernetes.io/docs/concepts/storage/volume-snapshots/)
- [VolumeSnapshotClass](https://kubernetes.io/docs/concepts/storage/volume-snapshot-classes/)
- [Images](https://kubernetes.io/docs/concepts/containers/images/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Server-side apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- [Garbage collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
- [Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- [Encrypting confidential data at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
