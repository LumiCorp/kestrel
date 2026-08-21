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

# Slice 6: Lean Control Plane, Administration, And Operations

## Outcome And User-Visible Result

An organization administrator can opt into the pre-release Kubernetes BYOC feature, enroll and qualify a connector, create an Environment on an explicitly selected cluster, operate and reconcile it, inspect sanitized diagnostics, and delete and revoke it through supported product surfaces. No routine database access or `kubectl` repair is required.

The complete API and UI remain behind the off-by-default `kubernetes_byoc` organization flag. Slice 6 is not deployed independently for general production use before Slice 7 completes real-cluster certification and the pilot proof.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slices 1-5 provide provider-neutral contracts and persistence, trusted outbound connector transport, qualification, the Kubernetes lifecycle adapter, execution-ticket v3, gateway-config v4, logical preview and idle contracts, and acknowledged replacement routing. Slice 6 owns control-plane registry adoption, durable multi-command operations, Kubernetes admission, administration, backup/recovery orchestration, reconciliation, deletion, systems, cost semantics, diagnostics, UI, and audit.

Slice 7 owns every KIND and managed-cluster run, CSI and NetworkPolicy proof, public ingress and TLS proof, certification, artifact publication, and pilot rollout.

## Locked Architectural Decisions

- `kubernetes_byoc` is an organization-admin opt-in. There is no second deployment gate, operator authorization gate, or organization connection/template policy.
- Kubernetes creation also requires `hosted_environments` and `KESTREL_HOSTED_ROUTING_CONTRACT_MODE=logical-v1`.
- Missing `provider` means Fly for backward compatibility. Kubernetes creation always names a connection, runtime template, and positive workspace limit.
- Qualification gates new Environment bindings only. A bound Environment remains operable while its immutable connection and active connector identity remain non-revoked.
- Infrastructure configuration freezes after the first non-deleted Environment binding. Qualification, connector commands, and lifecycle admission bind to the infrastructure-only revision. Display name and default selection remain editable and do not invalidate qualification.
- Configuration changes with zero active bindings invalidate qualification. Existing bindings never silently inherit a new profile, domain, class, selector, pull Secret, template list, or attestation.
- Reconciliation restores only recorded Kestrel-owned desired state. It never selects a provider, connection, image, class, quota, edge mode, or workspace limit.
- Revocation requires no active Environments or commands and a current empty inventory. There is no force-revoke path.
- Kubernetes billing owner is `customer`; monetary cost is unknown. Kestrel records requested-resource observations but never applies Fly prices.
- Connector upgrades remain manual and digest-pinned. Installed version and contract compatibility are factual; semantic-version comparison does not imply upgrade availability.

## Public Contracts, Schemas, And Wire Formats

Migration `0080_kubernetes_byoc_control_plane.sql` replaces the unique connector-command `operation_id` index with a normal lookup index and adds `environment.reconcile` to the Environment operation constraint. `(provider_connection_id, idempotency_key)` remains unique. `environment_operations.connector_command_id` remains the latest-command compatibility pointer; complete timelines query every command with the operation ID.

Environment creation accepts:

```ts
type CreateEnvironmentInput =
  | {
      provider?: "fly";
      name: string;
      slug?: string;
      region: FlyRegionCode;
      isDefault?: boolean;
    }
  | {
      provider: "kubernetes";
      name: string;
      slug?: string;
      providerConnectionId: string;
      runtimeTemplate: string;
      workspaceLimit: number;
      isDefault?: boolean;
    };
```

The Kubernetes path validates admin authority, both organization flags, logical routing, organization ownership, ready/non-revoked connection state, active connector identity, current passed and unexpired qualification at the current infrastructure revision, template membership in the connection configuration, and a positive integer workspace limit.

Administration adds:

- `GET/PATCH /api/organization/infrastructure/kubernetes/settings`;
- `GET /api/organization/infrastructure/kubernetes/connections`;
- existing enrollment, approval, configure, qualify, and revoke routes under common organization authority;
- `GET /api/organization/infrastructure/kubernetes/connections/:id/diagnostics`;
- `POST /api/organization/environments/:id/reconcile`.

Connection and diagnostic responses expose logical identity, lifecycle/support state, presence, compatibility, bounded configuration and qualification summaries, operation and command timelines, normalized failures, conditions, and residual inventory. They never expose credentials, private or signing keys, Secret values, encrypted envelopes, kubeconfig, or raw provider metadata.

## Ordered Implementation Phases

1. Apply migration 0080 and contract-test multiple deterministic connector commands per operation, replay reattachment, and the latest-command pointer.
2. Add strict Fly-compatible/Kubernetes creation parsing and atomically persist Environment, immutable connection binding, neutral placement, pinned runtime images, and `environment.provision`.
3. Refactor operation processing to resolve `EnvironmentInfrastructureProviderV2` from the Environment binding without Fly or cross-cluster fallback.
4. Convert provisioning, update, workspace lifecycle, replacement, backup, restore, deletion, and normalized observation persistence to registry-resolved resources. Dual-write legacy columns only for Fly.
5. Implement `environment.reconcile` and make scheduled/manual health refresh queue the same durable operation.
6. Freeze infrastructure configuration after binding, invalidate qualification on unbound infrastructure changes, and enforce clean-state revocation.
7. Add BYOC settings, connection, enrollment approval, qualification, compatibility, diagnostics, and manual-upgrade administration surfaces.
8. Extend Environment creation/detail, systems, health, operation progress, residual-resource, and organization-deletion surfaces.
9. Add customer-billed/unknown cost presentation and requested CPU, memory, PVC, snapshot, workspace, image, placement, and condition inventory.
10. Add organization-scoped, redacted audit events and hermetic, process, Postgres, Chromium, audit, docs, and public-boundary proof.

## Data Flow And Lifecycle Behavior

The administrator enables BYOC, installs the connector chart, opens its verification path, compares and approves the fingerprint, supplies structured v1 connection configuration, and runs qualification. Environment creation selects that ready connection and one allowed runtime template and persists the immutable binding with the provision operation in one transaction.

Every worker resolves exactly the Environment's recorded connection through the provider registry. Kubernetes resolution requires a non-revoked connection and active connector identity; it does not reapply the creation-time qualification gate. Each provider call emits deterministic commands from the durable operation ID, command type, logical identities, replacement ID, and desired revision. Replay reattaches to every prior command and emits only missing later commands.

Backup manifests store neutral snapshot and source-resource references while continuing to read legacy Fly manifests. Replacement promotion locks the workspace, promotes neutral provider-resource rows, updates Fly compatibility columns only for Fly, refreshes the Router, requires the exact route generation, proves the logical route, and only then retires old resources.

`environment.reconcile` inventories the Environment and all workspaces, compares live observations with active resource rows and desired revisions, and reapplies missing or drifted owned state. Customer-owned consumers and field conflicts are reported without mutation. Manual refresh and scheduled health use this operation rather than holding an HTTP request open against Kubernetes.

Organization deletion queues provider-neutral Environment deletion, waits for connector-confirmed cleanup, blocks while the connector is offline or inventory is residual/unknown, cleanly revokes Kubernetes connections, and only then permits organization cascade.

## Security And Trust Boundaries

- Organization-admin authority and organization ownership are checked server-side on every administration mutation.
- Disabling the opt-in blocks new connector approval and Kubernetes Environment admission; it does not strand or disable existing bound Environments.
- The provider registry never falls back to Fly or another Kubernetes connection.
- The UI accepts structured connection configuration only and never accepts arbitrary manifests, selectors at Environment creation, shell commands, or raw environment variables.
- Configuration secrets, enrollment secrets, connector credentials, command secrets, signatures, and kubeconfig never enter presentation or audit DTOs.
- Reconciliation mutates only Kestrel-owned fields at recorded logical identities and reports customer-owned conflicts.
- Clean revocation and organization deletion fail closed when presence or inventory is unknown.

## Failure, Retry, Recovery, And Rollback Behavior

Retryable connector, Kubernetes, and control-plane failures retain the operation checkpoint and deterministic command sequence. Worker or connector restart reclaims the same commands and rereads live state. Non-retryable authorization, ownership, malformed-result, and customer-consumer conflicts produce normalized failures and durable evidence.

Qualification expiry or configuration mismatch rejects only new Kubernetes bindings. Existing bound Environments can provision workspaces, stop, start, update, back up, restore, reconcile, and delete until the connection is cleanly revoked. Feature disablement similarly blocks new admission without introducing an operation allowlist.

Application rollback keeps additive schema and readers, sets the organization opt-in off, and returns issuers to the compatible routing mode only after Kubernetes creation is disabled. Cleanup remains available. Fly and Desktop behavior is unchanged.

## Detailed Test Matrix

- Missing-provider Fly parsing; strict Kubernetes provider, connection, template, and positive workspace-limit parsing.
- Organization admin/member and cross-organization feature, connection, Environment, diagnostics, reconciliation, and revocation authority.
- Hosted flag, BYOC flag, logical routing, connection readiness, connector identity, qualification expiry/revision, template, and workspace-limit admission failures.
- Atomic Environment, binding, placement, runtime-version, and provision-operation creation with no Kubernetes Fly aliases.
- Multiple commands per operation, deterministic replay, latest pointer, command timeline, worker restart, connector restart, and partial completion.
- Configuration freeze, presentation-only edits, qualification invalidation, multiple connections, default selection, and immutable binding.
- Clean revocation plus active Environment, active command, residual, unknown inventory, offline connector, and cross-organization failures.
- Fly and Kubernetes provision, update, start, stop, rebuild, backup, restore, reconcile, and delete through the registry and fake connector/Kubernetes servers.
- Reconciliation repairs recorded desired state without changing provider, connection, image, class, quota, edge mode, or workspace limit; customer-owned PVC consumers remain untouched.
- Organization deletion success, offline connector, failed deletion, residual inventory, retry, revocation, and eventual completion.
- Kubernetes customer-billed/unknown presentation, bounded requested-resource inventory, and absence of Fly rate-ledger entries.
- Chromium flows for opt-in, fingerprint approval, configuration, qualification, Environment creation, progress, diagnostics, reconciliation, deletion, and revocation.
- Audit actor, organization, target, result, and redaction assertions; public-boundary proof that provider topology remains confined to adapters, connector contracts, persistence, and administration DTOs.

## Validation Commands And Proof Artifacts

Run:

```sh
pnpm --filter @kestrel/kubernetes-connector test
pnpm --filter @kestrel/kubernetes-connector test:process
pnpm --filter @kestrel/kubernetes-connector typecheck
pnpm --filter @kestrel/kestrel-one test:unit
pnpm --filter @kestrel/kestrel-one typecheck
pnpm validate:postgres
pnpm validate:process
pnpm validate:chromium
pnpm validate:audit
pnpm run check:public-boundary
pnpm run check:docs
git diff --check
pnpm validate
```

Proof artifacts are classified only as hermetic, process, Postgres, Chromium, or audit evidence. No Slice 6 result is described as real-cluster or isolated-provider proof.

## Exit Criteria

- One operation durably executes and replays its complete connector-command sequence.
- Shared hosted lifecycle paths resolve Fly or Kubernetes through the v2 registry and neutral resource identities.
- An opted-in organization administrator can complete enrollment through clean Environment deletion and connection revocation without database changes or routine `kubectl`.
- Qualification affects new bindings only; existing immutable bindings remain manageable.
- Configuration cannot silently change infrastructure under an active Environment.
- Systems, costs, diagnostics, operations, and audit represent Kubernetes without fabricated prices or secret leakage.
- Fly and Desktop remain compatible, and no live cluster is required for Slice 6 acceptance.

## Explicit Exclusions And Handoff

This slice does not run KIND, deploy a managed cluster, prove CSI, NetworkPolicy, ingress, DNS, or TLS behavior, publish connector artifacts, certify GKE/EKS, approve a customer pilot, migrate Fly Environments, or release Kubernetes BYOC generally. Slice 7 owns all those gates. Organization administrators perform the product opt-in; operator approval in Slice 7 is a pilot-process requirement, not a product authorization gate.
