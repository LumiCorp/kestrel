import assert from "node:assert/strict";
import test from "node:test";
import {
  parseKubernetesByocProfileV1,
  resolveKubernetesByocSupportState,
  type KubernetesByocProfileV1,
} from "./kubernetes-byoc-profile";

const attestedEncryption = {
  persistentVolumes: {
    encryption: "provider_attested",
    evidenceRef: "customer-attestation:persistent-volumes",
  },
  kubernetesSecrets: {
    encryption: "provider_attested",
    evidenceRef: "customer-attestation:kubernetes-secrets",
  },
} as const;

const gkeProfile = {
  contract: "kubernetes-byoc-profile-v1",
  selectedCertificationProfile: "gke-gateway-v1",
  namespacePrefix: "kestrel",
  baseDomain: "environments.example.test",
  storageClassName: "standard-rwo",
  volumeSnapshotClassName: "pd-snapshots",
  controllerNamespace: "gke-managed-system",
  controllerPodSelector: { "app.kubernetes.io/name": "gateway-controller" },
  pullSecretRef: null,
  encryptionAttestations: attestedEncryption,
  edge: {
    mode: "gateway_api",
    parentNamespace: "kestrel-edge",
    parentName: "shared-gateway",
  },
  platform: {
    distribution: "gke",
    computeProfile: "standard",
    networkPolicyProvider: "gke_dataplane_v2",
    storageCsiDriver: "pd.csi.storage.gke.io",
    snapshotCsiDriver: "pd.csi.storage.gke.io",
    edgeController: "gke_gateway",
  },
} as const satisfies KubernetesByocProfileV1;

const eksProfile = {
  ...gkeProfile,
  selectedCertificationProfile: "eks-ingress-v1",
  storageClassName: "gp3",
  volumeSnapshotClassName: "ebs-snapshots",
  edge: { mode: "ingress", ingressClassName: "alb" },
  platform: {
    distribution: "eks",
    computeProfile: "managed_nodes",
    networkPolicyProvider: "vpc_cni_network_policy",
    storageCsiDriver: "ebs.csi.aws.com",
    snapshotCsiDriver: "ebs.csi.aws.com",
    edgeController: "aws_load_balancer_controller",
  },
} as const satisfies KubernetesByocProfileV1;

test("the exact GKE Gateway and EKS Ingress reference profiles are certified", () => {
  for (const profile of [gkeProfile, eksProfile]) {
    const parsed = parseKubernetesByocProfileV1(profile);
    assert.deepEqual(
      resolveKubernetesByocSupportState({
        profile: parsed,
        compatible: true,
        verifiedFacts: {
          profileId: profile.selectedCertificationProfile,
          platform: profile.platform,
          edgeMode: profile.edge.mode,
          evidenceLevel: "isolated_provider",
          evidenceRef: `proof:${profile.selectedCertificationProfile}`,
        },
      }),
      {
        state: "certified",
        profileId: profile.selectedCertificationProfile,
        reason: null,
      },
    );
  }
});

test("a selected reference profile remains qualified without isolated-provider evidence", () => {
  const profile = parseKubernetesByocProfileV1(gkeProfile);
  assert.deepEqual(
    resolveKubernetesByocSupportState({ profile, compatible: true }),
    {
      state: "qualified",
      profileId: "gke-gateway-v1",
      reason: "certification_evidence_required",
    },
  );
});

test("a compatible non-reference profile is qualified but never certified", () => {
  const profile = parseKubernetesByocProfileV1({
    ...gkeProfile,
    selectedCertificationProfile: null,
    platform: { ...gkeProfile.platform, distribution: "other" },
  });
  assert.deepEqual(resolveKubernetesByocSupportState({ profile, compatible: true }), {
    state: "qualified",
    profileId: null,
    reason: "non_reference_profile",
  });
});

test("an explicit certified profile ID fails closed when verified facts differ", () => {
  const profile = parseKubernetesByocProfileV1({
    ...gkeProfile,
    platform: { ...gkeProfile.platform, networkPolicyProvider: "calico" },
  });
  assert.deepEqual(resolveKubernetesByocSupportState({ profile, compatible: true }), {
    state: "unsupported",
    profileId: "gke-gateway-v1",
    reason: "reference_profile_mismatch",
  });
});

test("edge configuration is exactly Gateway API or Ingress", () => {
  assert.throws(() =>
    parseKubernetesByocProfileV1({
      ...gkeProfile,
      edge: {
        mode: "gateway_api",
        parentNamespace: "kestrel-edge",
        parentName: "shared-gateway",
        ingressClassName: "alb",
      },
    }),
  );
  assert.throws(() =>
    parseKubernetesByocProfileV1({
      ...eksProfile,
      edge: { mode: "ingress" },
    }),
  );
});

test("unknown encryption cannot satisfy a certified Kubernetes profile", () => {
  const profile = parseKubernetesByocProfileV1({
    ...gkeProfile,
    encryptionAttestations: {
      ...attestedEncryption,
      persistentVolumes: { encryption: "unknown", evidenceRef: null },
    },
  });
  assert.equal(
    resolveKubernetesByocSupportState({ profile, compatible: true }).state,
    "unsupported",
  );
});
