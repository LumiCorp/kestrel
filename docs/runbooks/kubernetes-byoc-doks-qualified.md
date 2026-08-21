---
id: kubernetes-byoc-doks-qualified-runbook
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-20
depends_on:
  - ../plans/byoc/Slice-7.md
  - ../research/2026-08-17-completing-kubernetes-byoc.md
---

# Kubernetes BYOC: DOKS Qualified Validation

This runbook is the lowest-cost credible live-provider check for Kubernetes
BYOC. It uses a disposable, single-node DigitalOcean Kubernetes (DOKS) cluster
for one `qualified` run. It does not create a certified profile, publish a
production support claim, or provision cloud resources from repository code.

## Boundaries and evidence

- KIND is the zero-cost local smoke gate. Label its output `kind_smoke` (or
  `hermetic` for repository tests); it receives no isolated-provider credit.
- DOKS output is `isolated_provider` evidence with profile `qualified`.
- GKE and EKS remain the only `certified` profiles. A passing DOKS run cannot
  substitute for either reference profile.
- The operator creates and deletes the DOKS cluster manually. Do not add
  `doctl`, cloud-account, DNS, load-balancer, or registry provisioning to the
  canary or repository scripts.
- Use only disposable test data and a connection dedicated to this run.

## Cost guard

Create a teardown deadline before creating the cluster. DOKS control planes are
free; worker, block-storage, load-balancer, and DNS charges still apply. A
single Basic worker is the lower-cost option, while a 2-vCPU/4-GiB worker is a
more realistic minimum for the two-replica connector and qualification pods.
Check the [current DOKS pricing](https://www.digitalocean.com/pricing/kubernetes)
before each run, set a billing alert, and record the start and deletion times
in the proof summary.

The cluster must have:

- one worker node and no autoscaling or additional node pools;
- a non-HA control plane where the selected DOKS plan permits it;
- a current VPC-native Kubernetes version (DOKS Gateway API requires the
  supported 1.33+ configuration);
- one temporary public load balancer and one test DNS name only when the edge
  probe requires them; and
- an explicit owner and UTC teardown deadline.

## Stage 0: local smoke (optional)

Run repository gates first:

```sh
pnpm --filter @kestrel/kubernetes-connector test
pnpm --filter @kestrel/kubernetes-connector test:process
pnpm --filter @kestrel/kubernetes-connector typecheck
pnpm --filter @kestrel/kubernetes-connector release:check
pnpm test:kubernetes:doks
pnpm run check:docs
pnpm run check:public-boundary
```

If Docker and KIND are available, use a disposable local cluster:

```sh
kind create cluster --name kestrel-byoc-smoke
helm upgrade --install kestrel-connector deploy/kubernetes/kestrel-connector \
  --namespace kestrel-system --create-namespace \
  --set image.digest=sha256:<published-connector-digest>
kubectl -n kestrel-system rollout status deployment/kestrel-connector --timeout=120s
helm uninstall kestrel-connector --namespace kestrel-system
kind delete cluster --name kestrel-byoc-smoke
```

Use a published immutable image digest. If KIND, Docker, or the required local
image is unavailable, record `kind_smoke: skipped`; do not turn a skipped local
smoke into a failed DOKS claim. The smoke check covers installation, startup,
health, enrollment wiring, and uninstall only. It does not prove cloud CSI,
Gateway API, Ingress, DNS, TLS, NetworkPolicy enforcement, or certification.

## Stage 1: manually create the DOKS cluster

Use the DigitalOcean dashboard or an operator-approved `doctl` invocation. The
repository must not contain cluster-creation automation. Select a single
VPC-native worker and record the cluster name, region, Kubernetes version, node
size, and teardown deadline in the local run notes. Do not commit kubeconfig or
cloud credentials.

DOKS's managed Gateway API is enabled by default for the supported VPC-native
Kubernetes 1.33+ configuration and uses Cilium. Follow the
[DOKS Gateway API guide](https://docs.digitalocean.com/products/kubernetes/how-to/use-gateway-api/)
for the cluster-specific GatewayClass and controller details. Do not silently
switch this run to Ingress if the Gateway API prerequisite is unavailable; stop
and record the blocked qualification.

Confirm the block-storage CSI and snapshot prerequisites from the live cluster.
The expected DOKS driver is `dobs.csi.digitalocean.com`; the exact class names
and controller selectors are observed values, not guessed constants. The
[DOKS snapshot guide](https://docs.digitalocean.com/products/kubernetes/how-to/create-snapshots/)
and [volume feature reference](https://docs.digitalocean.com/products/kubernetes/details/volume-features/)
describe the supported RWO and snapshot behavior.

## Stage 2: read-only cluster preflight

Point `kubectl` at the disposable cluster and write a sanitized facts artifact:

```sh
pnpm kubernetes:doks:preflight -- \
  --context <doks-context> \
  --output artifacts/doks-cluster-facts.json \
  --storage-class do-block-storage \
  --snapshot-driver dobs.csi.digitalocean.com
```

The preflight is read-only. It verifies a Ready node, the DOKS block-storage
provisioner, a matching `VolumeSnapshotClass`, Gateway API, a Cilium workload,
and the observed Kubernetes version. It records only hashes and bounded facts;
it does not include kubeconfig, tokens, Secret data, or raw Kubernetes objects.
Use `--gateway-controller <exact-controller-name>` when the configured
connection must pin a specific GatewayClass controller.

The preflight must pass before installing the connector. Save the output next
to (but not inside) the final proof bundle and review it for accidental
credentials before sharing it.

## Stage 3: install, enroll, and qualify

Publish the connector image and Helm chart manually with immutable, signed
digests. Record the exact image digest, chart digest, signature, and provenance
references. Never use `latest` or another mutable tag.

Install the chart from the reviewed chart package and set the image digest and
the Kestrel One base URL:

```sh
helm upgrade --install kestrel-connector <reviewed-chart-package-or-oci-digest> \
  --namespace kestrel-system --create-namespace \
  --set image.digest=sha256:<published-connector-digest> \
  --set kestrel.baseUrl=https://<kestrel-one-host> \
  --set kestrel.connectorDisplayName=doks-qualified-<proof-tag>
kubectl -n kestrel-system rollout status deployment/kestrel-connector --timeout=180s
```

Complete enrollment and fingerprint approval through the organization-admin
surface. Configure the connection with the observed facts from preflight:

```json
{
  "selectedCertificationProfile": null,
  "platform": {
    "distribution": "other",
    "computeProfile": "<observed-worker-profile>",
    "networkPolicyProvider": "<observed-cilium-policy-fact>",
    "storageCsiDriver": "dobs.csi.digitalocean.com",
    "snapshotCsiDriver": "dobs.csi.digitalocean.com",
    "edgeController": "<observed-gateway-controller>"
  },
  "edge": {
    "mode": "gateway_api",
    "parentNamespace": "<approved-gateway-namespace>",
    "parentName": "<approved-gateway-name>"
  },
  "storageClassName": "do-block-storage",
  "volumeSnapshotClassName": "<observed-snapshot-class>",
  "controllerNamespace": "<observed-controller-namespace>",
  "controllerPodSelector": { "<observed-selector-key>": "<observed-selector-value>" },
  "encryptionAttestations": {
    "persistentVolumes": { "encryption": "unknown", "evidenceRef": null },
    "kubernetesSecrets": { "encryption": "unknown", "evidenceRef": null }
  }
}
```

Keep `KESTREL_HOSTED_ROUTING_CONTRACT_MODE=logical-v1`. Request qualification
after configuration and verify:

- support state is `qualified`, never `certified`;
- connector presence, accepted command/result contracts, and current revision
  are healthy;
- RWO PVC, snapshot, Gateway conditions, cleanup, and encryption evidence are
  reported accurately; and
- the qualification expiry is later than the planned canary and teardown.

Do not set a provider-attested encryption value without evidence from the
provider. Unknown encryption is valid for this non-reference qualified run.

## Stage 4: run the qualified canary

Use a non-default, disposable Environment and the existing authenticated
admin-operation canary:

```sh
pnpm --dir apps/web canary:environment:kubernetes -- \
  --connection <connection-id> \
  --profile qualified \
  --tag doks-<timestamp> \
  --evidence artifacts/doks-proof.json \
  --scenario-evidence artifacts/doks-scenarios.json
```

The canary must receive the immutable artifact and qualification environment
variables required by `apps/web/scripts/environment-kubernetes-canary.ts`:

- Kestrel One URL and authenticated organization-admin cookie;
- organization ID and connection ID;
- connector image/chart digests plus signature and provenance references; and
- connector version and current qualification expiry;
- `KESTREL_KUBERNETES_VERSION` from `facts.kubernetesVersion`;
- `KESTREL_KUBERNETES_EDGE_CONTROLLER` from `facts.platform.edgeController`;
- `KESTREL_KUBERNETES_CNI` from `facts.platform.cni`;
- `KESTREL_KUBERNETES_STORAGE_CSI` from `facts.platform.storageCsi`;
- `KESTREL_KUBERNETES_SNAPSHOT_CSI` from `facts.platform.snapshotCsi`; and
- `KESTREL_KUBERNETES_NETWORK_POLICY` from `facts.platform.networkPolicy`.

The connection's sanitized `configuration.value.profile.edge.mode` is the
authority for the proof's `platform.edgeMode`; for this DOKS run it must be
`gateway_api`.

The canary creates and deletes resources through product APIs. It must never
insert provider rows, call a DigitalOcean API, or use `kubectl` to repair a
failed operation.

### Required scenario evidence

The scenario artifact must contain every required
`kubernetes-byoc-proof-v1` scenario. Each scenario records operation and
connector-command IDs, desired revisions, resource observations, conditions,
assertions, and request/audit IDs. Marking a scenario `not_run`, omitting it,
using a mutable digest, or reporting residual/unknown resources makes the proof
invalid.

| Scenario | DOKS assertions |
| --- | --- |
| `connector.qualification` | Enrollment, fingerprint approval, presence, compatibility, current qualification, and observed Gateway/CSI facts. |
| `environment.idempotency` | Repeated create/replay produces one Environment and one logical resource set. |
| `environment.resources` | Namespace, Gateway, Service, RWO PVC, quota, RBAC, and NetworkPolicy reconcile with Kestrel ownership. |
| `routing.public_boundary` | Only the exact qualified Router HTTPS hostname is public; the workspace Service is cluster-internal. |
| `routing.signed_execution` | A signed Router ticket reaches the bound workspace; the ticket contains logical gateway authority. |
| `routing.isolation` | Direct workspace, unsigned Router, cross-workspace, and cross-Environment probes are denied. |
| `workspace.persistence` | Stop reaches zero workspace Pods before PVC reuse; start preserves the nonce and Service identity. |
| `workspace.image_update` | Old Pods disappear before the new immutable image starts; observed digest and health are correct. |
| `workspace.rollback` | A failed image/config update is explicitly rolled back and never silently treated as success. |
| `workspace.snapshot_restore` | Snapshot becomes ready, replacement PVC/compute restore the nonce, route generation is acknowledged, and old resources retire only after proof. |
| `recovery.replay` | Worker/connector interruption reattaches to existing commands without duplicate resources. |
| `recovery.eviction` | Pod eviction followed by reconciliation preserves logical identity, RWO PVC, Service, and route. |
| `reconciliation.idempotency` | Drift repairs recorded Kestrel-owned state only; customer resources and ownership conflicts remain untouched. |
| `cleanup.environment` | Environment/workspace deletion leaves zero residual or unknown Kestrel resources and retains shared customer prerequisites. |

For every lifecycle checkpoint, record the PVC `spec.accessModes` as exactly
`["ReadWriteOnce"]` and record the matching Deployment/Pod count. Stop, update,
restart, eviction, replacement, and reconciliation must show zero workspace
Pods before the PVC is reused. Duplicate managed writers and customer-owned
PVC consumers are deterministic ownership conflicts, not cleanup work.

## Stage 5: review and teardown

Do not leave the cluster running while reviewing artifacts. Execute cleanup in
this order:

1. Disable new Kubernetes Environment creation for the test organization.
2. Stop workspaces and delete the canary Environment through product operations.
3. Poll connector inventory until the canary namespace has no Kestrel-owned
   resources. Unknown or residual resources block teardown completion.
4. Revoke the connection only after clean inventory and no active commands.
5. Uninstall the Helm release and confirm the connector namespace is empty.
6. Delete the temporary load balancer, volumes, snapshots, DNS record, and any
   temporary registry artifact.
7. Delete the DOKS cluster manually before the teardown deadline.
8. Save the sanitized proof and a cost summary; do not save kubeconfig,
   credentials, service tokens, encrypted envelopes, or Secret data.

The final proof is successful only when the parser accepts
`kubernetes-byoc-proof-v1`, evidence class is `isolated_provider`, profile is
`qualified`, every scenario is `passed`, and cleanup has zero residual and
unknown resources. A blocked or offline connector is not a successful rollback.

## What this run does not prove

This run does not certify GKE or EKS, validate cloud-account automation, support
arbitrary Kubernetes manifests, establish provider cost, or authorize general
production rollout. Keep DOKS artifacts separate from GKE/EKS certification and
pilot artifacts. The next live-provider step is the Slice 7 reference-profile
matrix, not bulk Fly-to-Kubernetes migration.
