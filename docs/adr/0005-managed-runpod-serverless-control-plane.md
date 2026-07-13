---
id: adr-managed-runpod-serverless-control-plane
domain: kestrel-one
status: active
owner: kestrel-one
last_verified_at: 2026-07-12
depends_on:
  - ../../AGENTS.md
  - ../../SECURITY.md
  - ../../apps/web/drizzle/schema.ts
  - ../../apps/web/lib/ai/managed-runpod-contracts.ts
  - ../../apps/web/lib/ai/managed-runpod-runtime.ts
  - ../../apps/web/lib/ai/gateway-credential-lease.ts
---

# ADR 0005: Managed RunPod Serverless Control Plane

## Status

Accepted

## Context

Kestrel One can register an already-provisioned model gateway, but that contract
does not own provider infrastructure, tenant quotas, lifecycle state, or usage
attribution. Managed RunPod support needs a separate control-plane model so a
platform administrator can qualify an approved container once and entitled
organization members can launch and remove tenant-owned inference endpoints
without receiving the platform RunPod credential or leaving Kestrel.

The first provider is RunPod Serverless with an OpenAI-compatible vLLM endpoint.
Raw GPU Pods, arbitrary user-supplied images, arbitrary provider fields,
customer invoicing, and cross-provider lifecycle abstractions are outside this
decision. Existing externally configured gateways remain supported and do not
become managed deployments.

## Decision

Kestrel will use five explicit ownership layers:

- A single platform-scoped
  [`ai_provider_connections`](../../apps/web/drizzle/schema.ts) row owns the encrypted
  RunPod API credential or its environment-variable reference. Browser and
  tenant APIs expose only sanitized connection state.
- Immutable, versioned `ai_deployment_profiles` rows, validated by the
  [managed RunPod contracts](../../apps/web/lib/ai/managed-runpod-contracts.ts),
  are the allowlist. A
  profile pins a container digest, expected model ID, bounded template and
  endpoint specifications, and a cost ceiling. Activation requires disposable
  provider resources to pass exact model discovery plus streaming tool-call and
  tool-result validation; activating a version deprecates the previous active
  version of the same profile key. Template environment values are non-secret
  configuration; secrets use RunPod-owned secret references, private registries
  use provider-owned registry-auth references, and credential values must not be
  stored in profile JSON.
- Organization policy and entitlement rows govern launch authority and an
  organization-wide active-deployment quota. Quota evaluation and deployment
  creation occur in one transaction under a policy-row lock. Organization
  administrators can manage member entitlements and delete deployments, while
  an entitled creator can launch and delete their own deployment.
- Every launch snapshots the immutable profile into `ai_deployments`, records
  provider IDs and lifecycle runs, and creates a disabled organization-scoped
  gateway. The gateway becomes selectable only after the expected model is
  discovered and validated. Credential leases bind gateway, model, and
  organization; a managed lease additionally requires its deployment to remain
  ready.
- PgBoss owns asynchronous qualification, provisioning, deletion,
  reconciliation, and billing ingestion. Deterministic provider resource names
  and persisted provider IDs make retries idempotent. Deletion is endpoint-first
  and treats provider `404` responses as success. Reconciliation disables a
  gateway when its provider endpoint disappears, and hourly billing records are
  attributed to deployments by provider endpoint ID.

The feature remains behind `RUNPOD_MANAGED_DEPLOYMENTS_ENABLED` until the
migration, platform connection, first active profile, organization policies,
and worker scheduling are operational. The relational schema is provider-aware
where required, but the RunPod REST adapter and its specifications remain
provider-specific; a second provider must prove shared lifecycle semantics
before a generalized provisioning interface is introduced.

## Consequences

- Tenants can use only platform-qualified, digest-pinned images and bounded GPU
  configurations. They never submit a container image, provider endpoint, API
  key, or raw infrastructure payload.
- Managed gateways coexist with global gateways but are discoverable and
  leasable only by their owning organization. The CLI cache key includes the
  organization so otherwise identical model references cannot share leases.
- Provisioning can be retried after process or provider failure without
  intentionally creating duplicate templates, endpoints, gateways, or billing
  buckets. Failed resources remain tracked for explicit retry or deletion;
  disposable qualification resources are cleaned up on terminal failure.
- Provider-reported spend is operational attribution, not a billing ledger or
  chargeback mechanism. Alerts, hard spend enforcement, customer pricing, and
  invoice integration require a separate decision.
- Supporting Hugging Face, Bedrock, or another GPU provider will require a new
  adapter, qualification contract, and provider-specific schema validation. It
  must preserve tenant isolation, immutable snapshots, lifecycle evidence, and
  secret-handling guarantees established here.
