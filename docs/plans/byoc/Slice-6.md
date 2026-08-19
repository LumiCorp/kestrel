---
id: kubernetes-byoc-slice-6
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
  - Slice-5.md
---

# Slice 6: Control Plane, Administration, And Operations

## Outcome And User-Visible Result

An authorized organization administrator can register and qualify multiple Kubernetes clusters, create Kubernetes Environments, observe and operate their workspaces, backups, updates, and deletion, inspect connector and provider evidence, and revoke access through supported product surfaces. Routine operation requires neither direct database changes nor `kubectl` repair.

Kubernetes BYOC remains organization-flagged and manually activated. Automatic behavior is limited to recovering the recorded desired state of resources an administrator already created or changed.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slices 1-5 provide provider-neutral contracts, persistence, connector trust and qualification, full Kubernetes lifecycle operations, execution-ticket v3, gateway-config v4, provider-neutral previews/idle reporting, and acknowledged replacement routing. Remaining Fly-specific construction exists across process runtime, Kubernetes backup orchestration, reconciliation, organization deletion, systems map, metering, create/update APIs, and Environment administration UI.

This slice owns complete provider-registry adoption, public/admin APIs, organization policy, UI, audit, health, cost semantics, support diagnostics, feature flags, and operator documentation. It does not certify or generally release the feature; Slice 7 owns proof and pilot rollout.

## Locked Architectural Decisions

- Only organization administrators may approve, configure, qualify, default, revoke, or upgrade a Kubernetes connection.
- Multiple connections are allowed; one may be the default for new Kubernetes Environments.
- Environment connection binding is immutable after creation.
- Kubernetes Environment creation requires a ready connection, allowed runtime template, and explicit positive workspace limit.
- Provider registry is the only hosted infrastructure construction path.
- Reconciliation can restore recorded desired revision but cannot create Environments, switch providers/connections, change images, raise workspace limits, upgrade connectors, or alter cluster configuration.
- Connector installation and upgrades remain manual and digest-pinned.
- BYOC cost is customer-billed/unknown; Kestrel reports resource requests, not fabricated provider prices.
- Kestrel guarantees one writer among resources it manages for each `ReadWriteOnce` workspace PVC. Customer cluster administrators retain authority to create out-of-band PVC consumers and responsibility for resolving them.
- Feature enablement is per organization and defaults off.
- Kubernetes enablement fails closed unless `KESTREL_HOSTED_ROUTING_CONTRACT_MODE=logical-v1`; there is no provider-specific issuance exception.
- Bulk Fly-to-Kubernetes migration is out of scope.

## Public Contracts, Schemas, And Wire Formats

Add organization feature key `kubernetes_byoc`. Every administrator and runtime route checks both organization scope and this flag. Connector-authenticated cleanup and presence remain available long enough to revoke/clean disabled pilots, but disabling the feature blocks new connections, qualification, Environment creation, image update, and workspace creation.

Extend Environment create input to a discriminated provider union:

```ts
type CreateHostedEnvironmentInput =
  | {
      provider: "fly";
      region: FlyRegionCode;
      runtimeTemplate: string;
    }
  | {
      provider: "kubernetes";
      providerConnectionId: string;
      runtimeTemplate: string;
      workspaceLimit: number;
    };
```

Provider selection is explicit. Kubernetes does not consume organization Fly region settings. Add organization infrastructure policy for allowed provider connection IDs and runtime templates; do not add arbitrary Kubernetes selectors.

Expose sanitized connection views with identity, display name, provider, default, lifecycle/support status, connector version and compatible range, last presence, last qualification, edge mode/base domain, named classes, attestation status, failure summary, active Environment count, and upgrade requirement. Never expose keys, credentials, Secret data, raw encrypted payloads, or unrestricted provider metadata.

Expose operation views with logical stage, connector command status, last safe event, normalized error, provider-native request/audit reference, resource role, retryability, and residual cleanup references.

Add explicit administrator operations:

- register/approve/configure/qualify/default/revoke connection;
- create/delete Kubernetes Environment;
- update runtime image through existing runtime-channel operation;
- provision/start/stop/rebuild/delete workspace;
- create backup and restore/replacement;
- run reconciliation and inventory;
- inspect qualification and connector upgrade guidance.

No route accepts arbitrary Kubernetes manifests, resource names, selectors, annotations, environment variables, or shell commands.

## Ordered Implementation Phases

1. Replace direct Fly construction in process runtime, backups, reconciliation, organization deletion, systems map, and health with the Slice 2 provider registry.
2. Update all stores and presenters to use neutral connection/resource identities while retaining legacy fallback diagnostics.
3. Add the organization feature flag and server-side authorization around every Kubernetes administrator/runtime route.
4. Complete connection APIs and administrator UI for enrollment approval, configuration, attestations, qualification, support status, presence, revocation, and manual upgrade guidance.
5. Extend Environment creation and organization policy to support explicit Kubernetes connection, runtime template, and workspace limit.
6. Enable feature-flagged Kubernetes lifecycle actions through the existing durable Environment operation queue.
7. Add provider-neutral health, systems inventory, operation evidence, residual-resource, and connector status presentation.
8. Add customer-billed/unknown cost treatment plus requested CPU, memory, PVC, snapshot, and workspace-limit inventory.
9. Add structured audit events and validate their redaction and organization scope.
10. Add support bundles and operator documentation for installation through uninstall, including `ReadWriteOnce` same-node semantics, out-of-band consumer conflicts, and safe customer-owned Pod remediation.
11. Remove remaining direct Fly assumptions from shared hosted lifecycle call sites and add boundary tests preventing regression.

## Data Flow And Lifecycle Behavior

The connection flow is:

1. administrator installs the chart and opens the connector's verification path;
2. Kestrel shows connector fingerprint and non-authoritative cluster facts;
3. administrator approves it into the organization;
4. administrator configures edge, controller selectors, storage, snapshots, pull Secret, and attestations;
5. administrator runs read-only inspection and explicit active qualification;
6. connection becomes certified or qualified and may be selected for Environment creation.

Environment creation validates organization feature, admin role, ready connection, allowed policy, unique name/slug, runtime template, workspace limit, and current qualification. It persists the Environment and queues `environment.provision` atomically. The existing worker resolves the registry, invokes the Kubernetes proxy, and streams durable operation state to the UI.

Workspace and backup actions use the same operation APIs and status model as Fly. Provider-specific evidence is rendered beneath normalized stage and health, never substituted for Kestrel lifecycle truth.

Scheduled reconciliation reads recorded desired revisions and inventories only active Kestrel resources. It may enqueue repair for missing or drifted owned fields. It cannot select a new connection, image, class, edge mode, quota, or provider. Customer-field ownership conflicts produce a degraded Environment and an administrator action.

Connection revocation first prevents new commands and shows affected Environments. An administrator must stop/delete them or explicitly accept stranded resources. Safe revocation cancels queued commands, invalidates connector credentials, and records remaining resources. Helm uninstall instructions appear only after cleanup inventory is empty.

Organization deletion enumerates Kubernetes Environments, executes their recorded delete operations, verifies no Kestrel-owned residuals, revokes connections, then continues organization deletion. A connector offline or residual resource blocks completion with explicit evidence rather than silently orphaning infrastructure.

## Security And Trust Boundaries

- All administrator actions use existing organization-role authority and CSRF/request validation.
- Feature flag, organization, connection, Environment, and actor are checked in one server-side authority path.
- Attestation changes invalidate qualification and emit audit events.
- UI receives sanitized connection/config/evidence views only.
- Connector and Kubernetes errors are sanitized before audit, UI, or support bundles.
- Runtime desired-state recovery cannot broaden scope or permissions.
- Kestrel reports an observed customer-owned workspace-PVC consumer as `RESOURCE_CONFLICT`; it does not delete, relabel, or adopt that Pod. Existing operation and support diagnostics carry the sanitized conflict without adding an access-mode support state.
- Revocation and organization deletion fail closed when cleanup cannot be proven.
- Support bundles hash or redact organization, cluster, hostname, Secret, credential, ticket, and repository-sensitive values according to existing diagnostic rules.

## Failure, Retry, Recovery, And Rollback Behavior

An offline connector makes mutation actions unavailable but retains queued operation state. UI distinguishes connector offline, cluster rejected, workload unhealthy, and Kestrel worker unavailable.

Stale qualification blocks new Environment creation and configuration-dependent mutations but permits health, inventory, stop, backup when safe, delete, and revocation cleanup. The exact safe-operation allowlist is contract-tested; no general fallback is inferred.

Provider registry resolution failure is normalized and recorded on the operation. It does not fall back to Fly or another Kubernetes connection.

Feature rollback disables `kubernetes_byoc` for new actions while leaving status, cleanup, and revocation routes available to administrators. Fly and Desktop remain unaffected. Schema, resource rows, tickets, and connector evidence are additive and remain readable.

UI rollout follows server support: ship readers and status surfaces first, enable connection administration second, enable Environment creation only after Slice 7 gates. A UI must never offer an action the server does not authorize.

## Detailed Test Matrix

- Feature off/on by organization, admin/member role, cross-organization IDs, and revoked connection.
- Multiple connections, default selection, explicit selection, immutable binding, disabled default, and stale qualification.
- Kubernetes create validation for missing connection, wrong provider, disallowed template, invalid workspace limit, and non-ready connection.
- Atomic Environment row plus operation enqueue and duplicate idempotency.
- Every lifecycle action resolves Kubernetes through the registry and Fly through its adapter.
- Reconciliation repairs recorded desired state and rejects image, connection, quota, edge, or provider drift outside an explicit operation.
- Connection approval, configuration, attestation invalidation, qualification, support status, presence, upgrade required, and revocation.
- Sanitized API/UI views and absence of keys, Secret data, encrypted plaintext, kubeconfig, and raw provider payloads.
- Health and systems map for ready, degraded, offline, stale, deleting, and residual states.
- RWO conflict diagnostics distinguish duplicate Kestrel-managed compute from an observed customer-owned PVC consumer and never offer automatic deletion.
- Customer-billed/unknown cost with requested resources and no Fly rate application.
- Audit event existence, actor, organization, target, metadata redaction, and failure path.
- Organization deletion success, connector offline, delete failure, residual resource, and eventual resume.
- Chromium flows for install guidance, fingerprint approval, configuration, qualification, Environment creation, operation progress, failure recovery, and revocation.

## Validation Commands And Proof Artifacts

- Run focused provider registry, operation worker, backups, reconciliation, organization deletion, systems map, cost, API, authorization, and UI tests.
- Run Postgres, process, Chromium, and audit validation leaves.
- Run public-boundary and documentation checks for new administration surfaces.
- Run `pnpm validate` before the slice PR is ready.
- Capture administrator-flow screenshots or browser traces, redacted audit records, operation timelines, registry resolution proof, and organization deletion inventory.

## Exit Criteria

- No shared hosted lifecycle entry point constructs Fly or Kubernetes providers directly.
- A flagged organization administrator can complete connection enrollment through Environment deletion using supported product surfaces.
- Members and other organizations cannot inspect or mutate connections.
- Health, systems map, operations, audit, cost, and support diagnostics accurately represent Kubernetes and connector state.
- Reconciliation and runtime-channel actions remain inside the explicit manual-mutation boundary.
- Organization deletion cannot report success while Kestrel-owned Kubernetes resources remain unknown or present.

## Explicit Exclusions And Handoff

This slice does not enable general availability, automatically publish or upgrade connector artifacts, certify new cluster stacks, migrate Fly Environments, or remove compatibility fields/readers. Slice 7 executes the full proof matrix, staged enablement, pilot, rollback drill, and release decision.
