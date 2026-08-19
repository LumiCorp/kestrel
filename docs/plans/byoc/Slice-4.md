---
id: kubernetes-byoc-slice-4
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
  - Slice-3.md
---

# Slice 4: Kubernetes Environment Lifecycle Adapter

## Outcome And User-Visible Result

Every provider-neutral Environment and workspace lifecycle operation has a complete, idempotent Kubernetes implementation behind the connector. Operations survive hosted worker restarts, connector restarts, Kubernetes conflicts, and partial reconciliation without losing ownership or evidence.

This slice proves lifecycle correctness with hermetic fake-API, process, and Postgres evidence. It does not require KIND or a managed cluster, and it does not yet enable product creation or provider-neutral execution routing.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slice 2 provides durable Environment operations, provider resources, and connector commands. Slice 3 supplies a qualified connector, strict Kubernetes client, command transport, connection profile, and disposable fixture patterns.

The existing `EnvironmentProvisioner` remains orchestration authority for lifecycle order, checkpoints, retries, backup policy, replacement, and rollback. The Kubernetes adapter owns Kubernetes desired state, mutations, waits, inventory, and native evidence. Downstream rejection does not move ownership from the adapter or provisioner boundary that first made state wrong.

This slice owns connector command handlers, Kubernetes resource builders, remote provider proxy completion, lifecycle checkpoints, and lifecycle proof. Slice 5 owns execution and preview routing contracts.

## Locked Architectural Decisions

- Namespace, logical resource names, labels, and field-manager identity are deterministic from Kestrel IDs.
- Names are DNS-safe hashes or bounded slugs; display names never become authority.
- Workspaces use one-replica Deployments with `Recreate`, separately managed PVCs, and stable Services.
- Stop/start scales the Deployment to zero/one and never deletes the PVC.
- Workspace PVCs use `ReadWriteOnce`. Kestrel maintains at most one managed workspace Pod referencing a workspace PVC.
- Runtime and Router images are immutable digest references.
- Runtime Pods use Restricted security settings and `automountServiceAccountToken: false`.
- The connector uses server-side apply without force ownership for desired resources. Replica and image mutations use bounded strategic-merge patches so a scale operation cannot prune fields previously owned by server-side apply.
- Customer-owned Gateway, IngressClass, StorageClass, VolumeSnapshotClass, DNS, TLS, and source pull Secret are never deleted.
- Reconciliation may repair recorded desired state but may not change images, provider, connection, workspace limit, or edge configuration without an explicit operation.

## Public Contracts, Schemas, And Wire Formats

Preserve the published v1 envelope and its exact existing snake-case lifecycle command names:

- `ensure_environment_scope`, `ensure_environment_gateway`;
- `ensure_workspace_storage`, `ensure_workspace_compute`, `get_workspace_compute`;
- `start_workspace_compute`, `stop_workspace_compute`, `update_workspace_image`;
- `create_workspace_snapshot`, `is_workspace_snapshot_usable`;
- `create_replacement_workspace_storage`, `create_replacement_workspace_compute`;
- `list_environment_resources`;
- `delete_workspace_compute`, `delete_workspace_storage`, `delete_environment_scope`; and
- `wait_for_workspace_state`, `wait_for_workspace_health`.

Add strict payload schemas per command while retaining the generic `payload` and `output` envelope fields. Secrets use an opaque encrypted envelope bound to command ID; persistence contains only ciphertext and service-token hashes. Results add typed resource observations with disposition, UID, generation, conditions, image digest, placement, relationships, and service-token hash where applicable. No command/result version bump is required because lifecycle payloads were not externally published.

Each mutation carries desired revision, exact logical IDs, existing resource references if known, connection configuration revision, immutable image digest where relevant, and encrypted secrets. The connector rejects a command if its connection, Environment, namespace, or recorded UID conflicts with observed ownership.

Standard labels on every managed object are:

- `app.kubernetes.io/managed-by=kestrel-connector`
- `app.kubernetes.io/part-of=kestrel-environment`
- `kestrel.dev/organization-id-hash`
- `kestrel.dev/environment-id`
- optional `kestrel.dev/workspace-id`
- `kestrel.dev/resource-role`
- `kestrel.dev/desired-revision`

Do not place raw organization names, user IDs, repository names, or secrets in labels or annotations.

`ensure_environment_scope` owns Namespace metadata, ResourceQuota, LimitRange, baseline ServiceAccounts, the fixed connector RoleBinding, and NetworkPolicies. The namespace name is `<configured-prefix>-env-<stable-environment-hash>` and is stored as the Environment-scope external ID.

`ensure_environment_gateway` owns Router Deployment, Service, configuration Secret, service-token Secret, and exactly one HTTPRoute or Ingress. It returns gateway and edge-route references plus the externally verified Router URL. Configuration refresh authenticates logical Environment/gateway identity, and the Router must become ready from an empty valid configuration before Slice 5 adds workspace routes.

`ensure_workspace_storage` owns a PVC named from workspace ID. `ensure_workspace_compute` owns a Service, runtime configuration Secret, service-token Secret, and Deployment. Storage and compute remain separate resource references.

Migration `0078_kubernetes_lifecycle_replacements.sql` adds nullable `replacement_id` to provider resources. Primary rows retain `replacement_id IS NULL`; replacement compute/storage rows are unique by workspace, role, and replacement ID. Snapshot upserts are idempotent by provider connection, role, and external ID. Promotion tombstones the active primary pair and clears replacement identity from the complete replacement pair in one transaction.

All result payloads report created, adopted, unchanged, updated, or deleted disposition; resource UID and observed generation; conditions; image digest; requested and observed placement; and sanitized Kubernetes evidence.

## Ordered Implementation Phases

1. Implement deterministic naming, standard metadata, desired-revision hashing, server-side apply for desired resources, strategic-merge patches for replica/image mutations, condition parsing, watch/poll waits, and normalized Kubernetes errors.
2. Implement the hosted Kubernetes provider proxy that enqueues commands, checkpoints command IDs, follows events, maps completion to Slice 1 results, and reattaches after worker restart.
3. Implement `ensure_environment_scope` and environment inventory with namespace ownership, security policy, quotas, and limits.
4. Implement gateway resources, edge-mode builders, readiness waits, public signed-health verification, and safe update rollback.
5. Implement workspace PVC, Service, secrets, Deployment, readiness, start, stop, health, and deletion.
6. Implement immutable image update with a zero-Pod checkpoint and authoritative failure result; the orchestration layer issues an explicit rollback command.
7. Implement VolumeSnapshot create/inspect, replacement PVC from snapshot, replacement Deployment, transactional provider-resource promotion, and old-resource retirement.
8. Implement complete inventory and stale-resource classification using recorded references, labels, UIDs, and desired revisions.
9. Implement workspace and Environment deletion with deterministic ordering and residual reporting.
10. Wire all handlers into connector command dispatch and add hermetic fake-API, process, and Postgres lifecycle proof. Defer KIND and managed-cluster canaries to Slice 7.

## Data Flow And Lifecycle Behavior

Environment provisioning checkpoints and executes:

1. `ensure_environment_scope` creates/adopts the namespace and security baseline.
2. `ensure_environment_gateway` creates the private Router and customer-edge route.
3. Kestrel verifies signed public health before marking the Environment ready.
4. Resource references and connector evidence commit with the operation stage.

Quota is derived from the required workspace limit and selected runtime template: workspace CPU, memory, ephemeral storage, and PVC limits are multiplied by the limit, then fixed gateway and qualification-safe overhead is added. Stricter customer quota remains authoritative and produces an actionable qualification or scheduling failure.

Workspace provisioning checkpoints and executes storage before compute. The PVC is bound, its CSI driver observed, and its live `spec.accessModes` verified as exactly `[ReadWriteOnce]` before Deployment creation. The Service is stable across Pod replacement. Readiness requires a ready Pod, matching immutable digest, mounted expected PVC, workspace identity from health, and successful signed Router-to-workspace health.

The baseline policies select exact Kestrel labels:

- default deny ingress for all Pods;
- allow customer edge-controller selector to Router port only;
- allow Router selector to workspace runtime port only; and
- no egress isolation policy in v1.

Start scales to one and waits for full health. Stop sends the configured graceful termination, scales to zero, waits for no active Pod, and retains Service/PVC. Repeated start or stop is unchanged success.

Image update scales to zero, waits until no workspace Pod remains, applies the new digest, scales to one, and returns authoritative state. Failure does not hide the live state or perform an implicit connector-side rollback; orchestration may issue the explicit rollback operation through the same zero-Pod discipline.

Backup creates a VolumeSnapshot and waits for `readyToUse`. Restore requires an owned ready snapshot, creates a new PVC from it, creates replacement compute against the new PVC, and returns the replacement references. This slice supplies the transactional provider-resource promotion primitive; Slice 5 invokes it only after workspace data, health, and Router cutover proof. Old storage follows retention policy only after that cutover.

The single-writer invariant is evaluated per PVC. Restore may run old and replacement compute concurrently only because each references a different PVC; no two Kestrel-managed compute resources may reference the same workspace PVC.

Environment deletion stops and deletes workspace compute, handles storage according to retention, deletes gateway and route, then uses preferred-version Kubernetes discovery to list every deletable namespaced resource, including customer CRDs. Kubernetes Events are the sole non-stateful exclusion. Any object that is neither Kestrel-owned nor a fixed Kubernetes default blocks deletion before the namespace request. Namespace disappearance is required for success. Shared prerequisites are read-only throughout.

## Security And Trust Boundaries

- Apply Restricted container settings: non-root, read-only root filesystem where supported, dropped capabilities, seccomp runtime default, and no privilege escalation.
- Runtime Pods receive no Kubernetes API token.
- Secrets are written only from encrypted connector envelopes or copied from the configured source pull Secret. Secret values never appear in apply events or evidence.
- Pull-secret copying records only source UID/resourceVersion and destination UID, and reconciliation rotates copies when the source changes.
- Namespace, labels, recorded UID, connection, and role must all match before update or delete.
- Edge-source selectors are exact configured selectors; no broad namespace allow rule is synthesized.
- The connector never force-applies conflicting customer fields or removes unknown finalizers.
- Namespace Pod Security labels are reconciled on every scope ensure with server-side apply and `force=false`; drift cannot be reported as ready.
- Namespace-bound wildcard access is read-only and exists solely to prove complete cleanup inventory before namespace deletion; mutation remains an exact resource allowlist.
- The connector never deletes a customer-owned Pod that references a Kestrel workspace PVC. An observed out-of-band consumer blocks start, update, rollback, or recovery with `RESOURCE_CONFLICT` and exact sanitized evidence.
- Public Router URLs must use the configured base-domain suffix and pass external TLS verification before persistence.

## Failure, Retry, Recovery, And Rollback Behavior

Every mutation first reads current state. A retry returns unchanged success when desired revision and owned fields match. API 409 conflicts trigger a bounded reread and reapply only when field ownership remains Kestrel's. API 429, timeout, and transient 5xx return retryable evidence with server hints. Validation, forbidden, ownership conflict, and unsupported capability are deterministic failures. Progress-event delivery is best effort after its first ambiguous failure; command completion retries the same immutable result and never converts a control-plane transport failure into a provider failure.

Before creating or restarting workspace compute against an existing PVC, recovery inventories Deployments and Pods that reference that claim and reaches a recorded zero-Pod checkpoint. More than one Kestrel-managed compute resource referencing the same workspace PVC, or any observed customer-owned Pod consuming it, returns `RESOURCE_CONFLICT` and is never silently adopted, deleted, or reconciled as healthy.

If the hosted worker exits after command enqueue, operation replay reattaches to the command. If the connector exits during apply, the reclaimed command inspects Kubernetes state and resumes the desired revision. A later command with a different desired revision cannot reuse an older idempotency key.

Pod eviction and node loss are handled by Deployment reconciliation without changing logical compute identity. PVC attach delays remain an observable starting state until operation timeout.

Failed public edge readiness deletes only the Kestrel route and gateway resources created by the operation, not the customer edge. Failed workspace creation deletes new compute but retains or deletes new storage according to the provisioner checkpoint.

Replacement never deletes the old healthy compute/storage before new data and route health pass. If cutover fails, Router configuration stays on the old workspace. If retirement fails after successful cutover, the operation completes degraded with residual resources scheduled for explicit reconciliation.

Deletion blocked by finalizers remains running until timeout, then fails with exact residual references. No force-finalizer removal occurs.

## Detailed Test Matrix

- Deterministic names, labels, desired revision, and cross-organization collision resistance.
- Server-side apply create, unchanged, owned update, shared ownership, and conflict without force.
- Environment security baseline, quota derivation, Restricted policy, and exact NetworkPolicy selectors.
- Gateway API and Ingress manifests, conditions, edge readiness, TLS failure, and customer-resource retention.
- PVC `ReadWriteOnce` manifest and live readback, bind, delayed bind, wrong driver, missing/malformed/mixed/wrong access modes, and source pull-secret rotation.
- Workspace create, ready, unhealthy, stop, repeated stop, start, repeated start, duplicate managed compute ownership conflict, customer-owned PVC consumer conflict without deletion, Pod eviction, and node move.
- Image update success, zero-Pod checkpoint, interruption and replay at that checkpoint, bad image, probe failure, rollback success, and rollback failure.
- Snapshot ready, pending, driver error, restore, data mismatch, replacement success, cutover failure, and residual retirement.
- Inventory known, missing, stale revision, wrong UID, unknown Kestrel label, and customer object.
- API 409, 429 with retry-after, 5xx, timeout, invalid JSON, watch disconnect, and expired command lease.
- Hosted worker restart and connector restart at every operation checkpoint.
- Delete complete, retained storage, namespace terminating, unknown finalizer, discovered customer CRD, complete read-only authorization, and no deletion of shared prerequisites.

## Validation Commands And Proof Artifacts

- Run focused provider proxy, connector handler, resource builder, provisioner, backup, reconciliation, and deletion tests.
- Run process and Postgres validation leaves for command recovery and operation checkpoints.
- Run mutation proofs for provider idempotency, replacement, rollback, and deletion where registered.
- Run a hermetic fake-API state machine with deterministic watches and fault injection.
- Record Slice 4 proof as hermetic, process, or Postgres evidence. KIND, GKE, EKS, CSI, NetworkPolicy enforcement, ingress, DNS, and TLS canaries belong to Slice 7 and are never relabeled as Slice 4 provider proof.
- Run `pnpm run check:public-boundary` and `pnpm validate` before the slice PR is ready.
- Proof artifacts include command timeline, desired revisions, resource references/UIDs, Kubernetes conditions, health results, snapshot evidence, cleanup inventory, and evidence class.

## Exit Criteria

- Every Slice 1 provider method has a Kubernetes connector implementation.
- Operations resume from persisted checkpoints and connector commands without duplicate logical resources.
- Namespace, gateway, workspace, PVC, snapshot, replacement, inventory, update, start/stop, and deletion pass hermetic, process, and Postgres tests.
- Every existing provider method has a strict proxy mapping and connector handler, and command replay reattaches without duplicating logical resources.
- Replacement resources coexist and promote transactionally; cleanup never deletes shared or customer-owned resources.
- Kubernetes Environment creation remains disabled in worker routing until Slices 5 and 6 are complete.
- No lifecycle success is reported while required resources are unhealthy, snapshots unusable, or cleanup residuals unknown.
- Customer-owned edge, storage, snapshot, DNS, TLS, and pull-secret prerequisites are never deleted.

## Explicit Exclusions And Handoff

This slice does not change shared execution tickets, Preview Edge routes, authorization renewal, general administration UI, cost reporting, or production feature flags. Slice 5 owns the provider-neutral Workspace Runtime bootstrap contract, including exact Kubernetes runtime Secrets/environment variables, and makes execution and preview routing consume the stable Services and Router URL produced here.
