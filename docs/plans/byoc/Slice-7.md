---
id: kubernetes-byoc-slice-7
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
  - Slice-6.md
---

# Slice 7: Certification, Fault Proof, And Pilot Rollout

## Outcome And User-Visible Result

Kubernetes BYOC is release-ready for the two certified reference profiles and for explicitly approved non-reference clusters that pass qualification. GKE, EKS, one internal organization, and one customer pilot demonstrate the complete lifecycle with evidence that distinguishes hermetic, isolated-provider, pilot, and production proof.

The release has a rehearsed rollback that stops and deletes Kestrel-owned resources before connection revocation or Helm uninstall. No Fly Environment is automatically migrated.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slices 1-6 provide versioned contracts, additive persistence, trusted connector transport, full Kubernetes lifecycle, provider-neutral routing, administrator surfaces, observability, and a disabled organization feature flag.

Slice 4 deliberately supplied only hermetic fake-API, process, and Postgres lifecycle evidence. This slice owns every real-cluster proof: optional local KIND smoke coverage, disposable managed-cluster canaries, CSI behavior, enforced NetworkPolicy, Gateway API/Ingress controller behavior, public DNS, and TLS.

This slice owns proof tooling, certified cluster fixtures, fault injection, security review, artifact publication, staged enablement, pilot observation, rollback drills, and the final release decision. It may fix defects found by those gates but may not weaken the locked profile, bypass qualification, relabel mock evidence, or broaden automatic deployment authority.

## Locked Architectural Decisions

- Certification requires both declared reference profiles; one passing cluster is insufficient.
- GKE certification uses Gateway API; EKS certification uses Ingress.
- Both positive routing and negative isolation are mandatory.
- Non-reference clusters may be enabled only as `qualified`, never `certified`.
- Connector image and chart publication are manual, immutable, signed, and digest-addressed.
- Cluster installation and upgrade remain customer/admin Helm actions.
- Production feature enablement is organization-specific and manual.
- Pilot rollback is cleanup-first: stop/delete, verify inventory, revoke, then uninstall.
- Provider migration and bulk Fly-to-Kubernetes conversion are prohibited.
- Unit mocks, hermetic fake APIs, isolated provider clusters, pilot use, and production use are reported separately.

## Public Contracts, Schemas, And Wire Formats

Add a Kubernetes canary command owned by Web runtime tooling:

```text
pnpm --dir apps/web canary:environment:kubernetes -- \
  --connection <connection-id> \
  --tag <proof-tag> \
  --evidence <output-path>
```

The canary accepts only an existing ready connection and creates uniquely labeled disposable Environment/workspace records through public administration and operation services. It never bypasses the provider registry or writes provider tables directly.

Define `kubernetes-byoc-proof-v1` JSON:

- proof ID, timestamp, code revision, image/chart digests, connector version, command/result contract versions;
- organization, connection, Environment, and workspace identifiers in redacted or test-safe form;
- profile ID, support status, Kubernetes version, edge mode, CNI/network-policy evidence, CSI and snapshot drivers;
- per-scenario status, start/end, operation/command IDs, desired revision, resource references, provider conditions, request/audit IDs, and assertions;
- cleanup inventory split into Kestrel-owned deleted, customer-owned retained, residual, and unknown;
- evidence class `hermetic`, `isolated_provider`, `pilot`, or `production`;
- overall `passed: true` only when every required scenario and cleanup assertion passes.

The proof parser rejects missing scenarios, `not_run` required scenarios, residual or unknown Kestrel resources, mutable image tags, expired qualification, unsupported connector versions, and evidence-class escalation.

Add a certification registry entry only by committing a reviewed proof summary that references immutable artifacts. Runtime support status remains derived from explicit profile plus current qualification; it is not granted by an arbitrary uploaded proof.

## Ordered Implementation Phases

1. Build the provider-neutral Kubernetes canary on the same public services used by administrators.
2. Add the proof schema, strict parser, scenario registry, cleanup inventory, redaction, and release checks.
3. Add hermetic fault controls to the fake Kubernetes API and connector transport.
4. Provision disposable internal GKE and EKS certification clusters from reviewed infrastructure instructions; do not encode unapproved production mutations in repository scripts.
5. Run read-only and active qualification on each reference profile.
6. Run the full GKE Gateway API canary and resolve every failed assertion without weakening it.
7. Run the full EKS Ingress canary and resolve every failed assertion without weakening it.
8. Complete connector/RBAC/network/secret/routing threat review and fix all release-blocking findings.
9. Run every repository and package validation gate on the final code and artifact digests.
10. Manually publish the signed connector image and Helm chart, then verify their digest and provenance from a clean consumer.
11. Enable `kubernetes_byoc` for one internal organization, install from the published chart, and repeat the canary through UI/API authority.
12. Execute and document the full rollback drill on the internal organization.
13. Select one explicitly approved customer cluster, require current qualification, enable only that organization, and run a bounded pilot.
14. Review pilot evidence and residuals before deciding general availability. Do not enable organizations in bulk as part of this slice.

## Data Flow And Lifecycle Behavior

The canary creates one disposable Kubernetes Environment with a bounded workspace limit, one primary workspace, and one isolation-peer Environment/workspace. It uses the current runtime-channel image digests and the connection's configured edge and storage prerequisites.

Required scenarios run in order:

1. verify connector presence, version compatibility, current qualification, and attestations;
2. create Environment twice with the same idempotency key and prove one logical resource set;
3. create gateway and workspace, then verify all declared resources and desired revisions;
4. prove only the Router hostname is publicly reachable;
5. execute a signed command through Router to workspace;
6. prove direct workspace, unsigned Router, and cross-Environment attempts fail;
7. write a nonce to the workspace, stop, confirm zero Pods, start, and read the nonce;
8. update to a new valid image digest, prove the old Pod is absent before replacement starts, and prove health;
9. update to a deliberately bad test image/configuration and prove rollback to the prior digest;
10. create a snapshot, restore replacement storage, start replacement compute, read the nonce, cut over, and retire old compute;
11. interrupt hosted worker and connector at recorded checkpoints and prove replay resumes the same operation/command;
12. evict or delete the workspace Pod and prove logical identity, PVC, Service, and routing remain stable;
13. reconcile idempotently and prove no additional resources or field conflicts;
14. delete workspaces and Environments, verify namespace disappearance, and retain every customer prerequisite.

GKE and EKS evidence use separate proof files. Passing one does not satisfy the other. Customer pilot proof references its qualification but remains `pilot`, even when its stack matches a certified profile.

## Security And Trust Boundaries

- Certification clusters and organizations contain only disposable test data and dedicated credentials.
- Proof artifacts contain no bearer credential, private key, Kubernetes Secret value, ticket, source archive, or customer hostname not approved for evidence.
- Fault injection is available only in test/canary builds or through provider actions scoped to disposable labeled resources.
- Network negative tests originate from outside, same namespace, and peer Environment namespace where applicable.
- RBAC proof compares rendered chart permissions to the reviewed resource/verb allowlist and verifies runtime Pods have no ServiceAccount token.
- Image and chart verification checks signature, provenance, immutable digest, non-root runtime, and expected source revision.
- Customer pilot enablement requires explicit organization administrator and Kestrel operator approval recorded in audit evidence.

## Failure, Retry, Recovery, And Rollback Behavior

A failed canary stops dependent scenarios but always runs cleanup and proof finalization. Cleanup failure is a release failure, not a warning. Unknown inventory is treated as residual.

Transient cluster/provider failures may use the product's normal bounded retry behavior. The canary does not add its own unbounded retry or reinterpret a failed product operation as success.

If a certification defect requires contract, schema, or support-profile changes, return to the owning slice, update that document and implementation, invalidate prior proof, and rerun both reference profiles. Do not patch only the canary.

Internal rollback executes:

1. disable new Kubernetes Environment creation for the organization;
2. stop active pilot workspaces;
3. take any explicitly requested final backup;
4. delete Kestrel Kubernetes Environments through recorded operations;
5. run connector inventory until no Kestrel-owned resources remain;
6. revoke the connection and connector credentials;
7. uninstall the Helm release;
8. verify `kestrel-system` cleanup according to the uninstall runbook; and
9. disable the organization feature flag.

If the connector is offline during rollback, restore connector connectivity or perform a separately approved manual recovery using the exact recorded inventory. Do not report rollback complete while resources are unknown.

Application rollback keeps additive schema and legacy readers, disables feature creation, and deploys the last compatible control-plane release. Published connector artifacts remain immutable. Fly and Desktop continue independently.

## Detailed Test Matrix

Hermetic fault matrix:

- Kubernetes 401/403, 404, 409, 408, 429 with retry-after, 5xx, invalid JSON, slow response, and watch disconnect.
- Connector offline before claim, after claim, during lease, after mutation, during events, and before completion.
- Hosted worker exit before enqueue, after enqueue, during wait, after provider completion, and before checkpoint commit.
- Scheduler failure, image-pull failure, readiness failure, quota rejection, PVC pending, attach delay, missing/malformed/mixed/wrong live PVC access modes, lingering old Pod, snapshot pending/error, restore mismatch, and namespace terminating.
- Gateway/Ingress condition delay, DNS failure, TLS mismatch, Router health failure, stale config generation, and replacement cutover rejection.
- Credential rotation race, nonce replay, invalid signature, version mismatch, revocation, and expired qualification.

Reference-cluster matrix:

- GKE profile with Gateway API, Dataplane V2 policy, PD CSI, snapshot restore, wildcard TLS, and public route.
- EKS profile with AWS Load Balancer Controller Ingress, VPC CNI policy enforcement, EBS CSI, snapshot restore, wildcard TLS, and public route.
- Both run the complete ordered scenario list, connector restart, Pod eviction, worker restart, idempotent reconcile, and cleanup.
- Proof reads live Kubernetes resources and records `spec.accessModes: [ReadWriteOnce]` on every workspace PVC, Deployment-to-PVC and Pod-to-PVC mappings, zero matching Pods at stop and update checkpoints, and no additional compute after restart, eviction, or reconciliation.

Product matrix:

- organization admin versus member;
- feature disabled, internal enabled, and customer pilot enabled;
- certified versus qualified support presentation;
- connection current, stale, degraded, upgrade-required, and revoked;
- UI/API operation progress, audit evidence, cost semantics, systems inventory, organization deletion, and rollback.

## Validation Commands And Proof Artifacts

Run on the final code revision:

- `pnpm run check:docs`
- `pnpm run check:public-boundary`
- `pnpm validate`
- `pnpm validate:process`
- `pnpm validate:postgres`
- `pnpm validate:chromium`
- `pnpm validate:audit`
- registered mutation proofs for provider lifecycle and routing contracts;
- Helm lint/template plus RBAC allowlist validation;
- connector image build, startup/shutdown smoke, signature, provenance, and digest verification;
- the Kubernetes canary separately on GKE and EKS;
- internal organization browser/API canary and rollback drill; and
- one approved customer pilot proof.

Store proof JSON, a concise Markdown summary, command/operation timelines, sanitized conditions, network assertions, snapshot/restore evidence, resource inventory, and cleanup confirmation. Link immutable artifacts from the release decision. Do not promote raw logs containing sensitive material.

## Exit Criteria

- All repository and focused validation gates pass on the final revision.
- Connector image and chart are immutable, signed, manually published, and clean-install verified.
- GKE and EKS proof files pass every required scenario with zero residual or unknown Kestrel resources.
- Security review has no unresolved release-blocking connector, RBAC, Secret, routing, or isolation finding.
- Internal organization canary and cleanup-first rollback drill pass from published artifacts.
- One explicitly approved customer cluster passes current qualification and bounded pilot acceptance.
- Evidence is accurately labeled; no mock or isolated result is presented as production proof.

## Explicit Exclusions And Handoff

This slice does not bulk-enable organizations, migrate Fly Environments, add automatic connector upgrades, support arbitrary Kubernetes manifests or placement, add an egress proxy, infer infrastructure cost, or remove legacy Fly fields/ticket readers. Those require separately approved follow-up plans after BYOC v1 evidence is accepted.
