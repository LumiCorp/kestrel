---
id: kubernetes-byoc-slice-1
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
---

# Slice 1: Kubernetes Support Profile And Universal Contract

## Outcome And User-Visible Result

Kestrel has one versioned infrastructure contract that describes Kestrel concepts rather than Fly resources. Fly implements it without a behavior change, and Kubernetes BYOC has a published support profile and a frozen connector command envelope before any production cluster mutation is added.

An organization administrator can understand exactly what a cluster must provide, which combinations Kestrel certifies, which passing combinations are merely qualified, and which claims are provider-attested rather than independently verified. This slice does not expose Kubernetes Environment creation.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

The current `asher/k8s-byoc-universal-adapter` branch is a preflight spike. Retain its useful parts:

- the required capability vocabulary and compatibility assertion in `apps/web/lib/environments/providers/contracts.ts`;
- Fly capability declaration in `fly-machines.ts`;
- Kubernetes version and API discovery, exact `SelfSubjectAccessReview` checks, path-prefix preservation, named class validation, and CSI driver matching in `kubernetes-byoc.ts`; and
- their focused tests.

Do not merge the current `UniversalEnvironmentInfrastructureProvider` alias as the final abstraction. Its method inputs and outputs still expose apps, Machines, volumes, Fly regions, shared IPs, and Fly-only error codes. The production Kubernetes client also must not retain a hosted bearer-token authority; direct client injection remains test-only after the connector exists.

This slice owns shared provider types, capability evidence, the v1 Kubernetes compatibility profile, Fly conformance, and the connector wire envelope. It does not own database migrations, connector transport, Kubernetes manifests, execution-ticket changes, UI, or rollout.

## Locked Architectural Decisions

- Production Kubernetes access is connector-only and outbound from the customer cluster.
- Kestrel creates one namespace per Environment.
- A cluster connection is the placement boundary; arbitrary selectors, affinities, and tolerations are out of scope.
- The edge mode is explicitly either `gateway_api` or `ingress`; there is no discovery-based selection or fallback.
- Customers own wildcard DNS, TLS termination, and the shared Gateway or ingress controller.
- Kestrel owns per-Environment routes and verifies them externally.
- Workspace ingress is default-deny with gateway-only access; egress is open in v1.
- Workspace PVCs use `ReadWriteOnce`. Kestrel maintains at most one managed workspace Pod referencing a workspace PVC; access mode is not provider-configurable.
- PVC and Kubernetes Secret encryption require recorded customer attestation and are reported as provider-attested.
- GKE Standard with Dataplane V2, PD CSI snapshots, and Gateway API is certified profile `gke-gateway-v1`.
- EKS managed nodes with VPC CNI NetworkPolicy, EBS CSI snapshots, and AWS Load Balancer Controller Ingress is certified profile `eks-ingress-v1`.
- Other clusters may become `qualified` only after the full active qualifier passes; they never inherit a certified label.

## Public Contracts, Schemas, And Wire Formats

Introduce `EnvironmentInfrastructureProviderV2` next to the current interface. Its resources are opaque, typed Kestrel references:

```ts
type EnvironmentProviderKind = "fly" | "kubernetes";
type EnvironmentResourceRole =
  | "environment_scope"
  | "gateway"
  | "workspace_compute"
  | "workspace_storage"
  | "snapshot"
  | "edge_route";

type EnvironmentResourceRef = {
  provider: EnvironmentProviderKind;
  role: EnvironmentResourceRole;
  externalId: string;
  observedGeneration?: string;
};

type EnvironmentPlacement = {
  connectionId: string;
  requested: Record<string, string> | null;
  observed: Record<string, string> | null;
};
```

The public provider methods operate on Kestrel lifecycle concepts:

- `ensureEnvironmentScope`
- `ensureEnvironmentGateway`
- `ensureWorkspaceStorage`
- `ensureWorkspaceCompute`
- `getWorkspaceCompute`
- `startWorkspaceCompute`
- `stopWorkspaceCompute`
- `updateWorkspaceImage`
- `createWorkspaceSnapshot`
- `isWorkspaceSnapshotUsable`
- `createReplacementWorkspaceStorage`
- `createReplacementWorkspaceCompute`
- `listEnvironmentResources`
- `deleteWorkspaceCompute`
- `deleteWorkspaceStorage`
- `deleteEnvironmentScope`
- `waitForWorkspaceState`
- `waitForWorkspaceHealth`

Inputs contain logical organization, Environment, and workspace IDs plus desired runtime configuration. They never use `appName`, `machineId`, or `volumeId`. Provider-native identifiers enter and leave only through `EnvironmentResourceRef`.

Replace the unconditional volume `encrypted: true` field with:

```ts
type EnvironmentStorageSecurity = {
  encryption: "provider_verified" | "provider_attested" | "unknown";
  evidenceRef: string | null;
};
```

Kubernetes v1 compatibility requires `provider_attested`; Fly may return `provider_verified` when backed by its provider contract. No caller may convert `unknown` to a positive claim.

Normalize provider failures under `EnvironmentProviderErrorV2` with codes:

- `PROVIDER_NOT_CONFIGURED`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_REJECTED`
- `RESOURCE_CONFLICT`
- `RESPONSE_INVALID`
- `RESOURCE_UNHEALTHY`
- `CAPABILITY_UNSUPPORTED`
- `OPERATION_TIMEOUT`

Evidence retains `providerCode`, HTTP status, phase, provider request ID or Kubernetes audit ID, connector command ID, resource reference, and sanitized detail. The Fly adapter maps its existing `FLY_*` errors into these codes without discarding native evidence.

Define `KubernetesByocProfileV1` as a discriminated configuration contract. Shared fields cover namespace prefix, base domain, StorageClass, VolumeSnapshotClass, controller namespace and Pod selectors, optional pull-secret reference, and encryption attestations. Edge configuration is exactly one of:

```ts
type KubernetesEdgeV1 =
  | {
      mode: "gateway_api";
      parentNamespace: string;
      parentName: string;
      sectionName?: string;
    }
  | {
      mode: "ingress";
      ingressClassName: string;
    };
```

Define the connector envelope before implementing transport:

```ts
type InfrastructureConnectorCommandV1 = {
  contract: "infrastructure-connector-command-v1";
  id: string;
  idempotencyKey: string;
  connectionId: string;
  organizationId: string;
  environmentId?: string;
  workspaceId?: string;
  desiredRevision: string;
  type: KubernetesConnectorCommandType;
  payload: Record<string, unknown>;
  encryptedSecrets?: string;
};
```

Command types cover qualification and every provider method, but this slice only validates and serializes them. Results use `infrastructure-connector-result-v1`, return resource references and evidence, and contain no plaintext secrets. Presence advertises supported command/result versions. An unsupported version is a hard compatibility failure, never a best-effort fallback.

Evidence levels remain `implementation`, `api_discovery`, `cluster_preflight`, `isolated_provider`, `pilot`, and `production`. Capability descriptors must state the strongest evidence actually available.

## Ordered Implementation Phases

1. Add the profile, resource, placement, storage-security, evidence, normalized-error, connector-envelope, and connector-result types with strict runtime parsers.
2. Port the capability descriptor to the new types and remove the misleading universal alias.
3. Add a Fly v2 adapter that translates provider-neutral inputs to the existing Fly client and maps outputs and errors back.
4. Update provisioner test doubles to implement v2 while leaving orchestration behavior unchanged.
5. Refactor Kubernetes discovery to produce `KubernetesByocProfileV1` compatibility evidence but keep direct authority injection explicitly test-only.
6. Add certified profile definitions and an exact support-state resolver. Certification is selected by an explicit profile ID and verified profile facts, not guessed from provider strings or labels.
7. Add release checks that fail if shared provider contracts regain Fly-specific field names or connector envelopes accept unknown keys.

## Data Flow And Lifecycle Behavior

For Fly, the provisioner calls v2, the Fly adapter converts logical desired state into existing API calls, and native results are converted to resource references. No database representation changes in this slice.

For Kubernetes preflight tests, a `KubernetesByocProfileV1` plus injected fetch implementation enters the discovery client. The client returns capabilities, missing requirements, prerequisites, and evidence. It does not create resources or represent a usable connection.

Connector commands flow from a future provider proxy to a future connector. This slice fixes their identity, version, desired revision, payload boundaries, and result shape so persistence and transport can be implemented without revisiting lifecycle semantics.

## Security And Trust Boundaries

- Parsers reject unknown fields, empty identifiers, unsupported versions, invalid URLs, and malformed selectors before use.
- Profile data is non-secret. Secret values are represented only by references or an encrypted envelope.
- Provider detail is sanitized before it enters evidence or user-visible errors.
- Direct Kubernetes API credentials never become part of the public production contract.
- Encryption evidence records who attested, when, and what source was cited; it does not imply Kestrel cryptographic verification.
- Edge controller selectors are explicit configuration. Kestrel does not add keyword, label, or controller-name heuristics.

## Failure, Retry, Recovery, And Rollback Behavior

Adding v2 is additive. Keep the current Fly interface internally until every Fly call site uses the adapter, then stop exporting it without dropping stored fields. If any parity test fails, callers remain on the existing Fly implementation.

Contract-version mismatch fails before command claim or provider mutation. Error translation must preserve retryability: unavailable and timeout may be retried by existing orchestration; rejected, unsupported, and invalid response are deterministic until configuration changes; conflict follows the owning operation's reconciliation path.

Rollback removes v2 callers while leaving the new types unused. This slice performs no schema or provider mutation and therefore has no data rollback.

## Detailed Test Matrix

- All required capabilities present and each capability missing individually.
- Certified GKE and EKS profiles parse only with their exact edge and prerequisite fields.
- Qualified non-reference profiles never receive a certified status.
- Gateway API and Ingress configurations reject mixed or incomplete fields.
- Encryption `unknown` cannot satisfy Kubernetes readiness.
- Connector commands reject unknown type, version, key, empty ID, and malformed encrypted envelope.
- Connector results reject provider references for the wrong command role.
- Every Fly method maps arguments, results, state, health, and errors without behavior drift.
- Fly-specific field names are absent from shared v2 inputs and outputs.
- Kubernetes discovery preserves API path prefixes, distinguishes missing from denied verbs, validates classes, and rejects CSI driver mismatch.
- Evidence-level ordering prevents preflight from being labeled isolated-provider proof.

## Validation Commands And Proof Artifacts

- Run focused provider contract, Fly adapter, provisioner, and Kubernetes discovery tests.
- Run workspace typechecks for Web and shared environment-auth consumers touched by type exports.
- Run `pnpm run check:public-boundary`.
- Run `pnpm validate` before the slice PR is ready.
- Save the compatibility fixtures and Fly parity matrix in test output; do not describe mock results as provider proof.

## Exit Criteria

- No shared v2 lifecycle input or output uses Fly app, Machine, volume, or region vocabulary.
- Fly passes its existing lifecycle suite through the v2 adapter.
- Kubernetes support, certification, qualification, edge, encryption, and placement promises are explicit and versioned.
- Connector command and result v1 contracts are strict, documented, and frozen.
- The current preflight spike's useful tests are retained without presenting it as a complete provider.

## Explicit Exclusions And Handoff

This slice does not add tables, connector APIs, Helm assets, Kubernetes mutations, tickets, UI, or production rollout. Slice 2 consumes these exact contracts to introduce persistence, backfill Fly state, and resolve provider implementations.
