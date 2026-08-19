import { z } from "zod";
import { environmentStorageSecuritySchema } from "./contracts-v2";

export const KUBERNETES_BYOC_PROFILE_VERSION =
  "kubernetes-byoc-profile-v1" as const;
export const KUBERNETES_CERTIFIED_PROFILE_IDS = [
  "gke-gateway-v1",
  "eks-ingress-v1",
] as const;

export type KubernetesCertifiedProfileId =
  (typeof KUBERNETES_CERTIFIED_PROFILE_IDS)[number];

const kubernetesNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u,
    "Value must be a valid lowercase Kubernetes name.",
  );
const baseDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "Base domain must be a DNS hostname without a scheme or path.",
  );
const selectorKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/u,
    "Controller selector keys must use Kubernetes label syntax.",
  );
const selectorValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/u,
    "Controller selector values must use Kubernetes label syntax.",
  );

export const kubernetesEdgeV1Schema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("gateway_api"),
      parentNamespace: kubernetesNameSchema,
      parentName: kubernetesNameSchema,
      sectionName: kubernetesNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("ingress"),
      ingressClassName: kubernetesNameSchema,
    })
    .strict(),
]);

export type KubernetesEdgeV1 = z.infer<typeof kubernetesEdgeV1Schema>;

const platformFactsSchema = z
  .object({
    distribution: z.enum(["gke", "eks", "other"]),
    computeProfile: z.string().trim().min(1).max(120),
    networkPolicyProvider: z.string().trim().min(1).max(120),
    storageCsiDriver: z.string().trim().min(1).max(253),
    snapshotCsiDriver: z.string().trim().min(1).max(253),
    edgeController: z.string().trim().min(1).max(253),
  })
  .strict();

const encryptionAttestationsSchema = z
  .object({
    persistentVolumes: environmentStorageSecuritySchema,
    kubernetesSecrets: environmentStorageSecuritySchema,
  })
  .strict();

export const kubernetesByocProfileV1Schema = z
  .object({
    contract: z.literal(KUBERNETES_BYOC_PROFILE_VERSION),
    selectedCertificationProfile: z
      .enum(KUBERNETES_CERTIFIED_PROFILE_IDS)
      .nullable(),
    namespacePrefix: kubernetesNameSchema,
    baseDomain: baseDomainSchema,
    storageClassName: kubernetesNameSchema,
    volumeSnapshotClassName: kubernetesNameSchema,
    controllerNamespace: kubernetesNameSchema,
    controllerPodSelector: z
      .record(selectorKeySchema, selectorValueSchema)
      .refine((value) => Object.keys(value).length > 0, {
        message: "A controller Pod selector is required.",
      }),
    pullSecretRef: kubernetesNameSchema.nullable(),
    encryptionAttestations: encryptionAttestationsSchema,
    edge: kubernetesEdgeV1Schema,
    platform: platformFactsSchema,
  })
  .strict();

export type KubernetesByocProfileV1 = z.infer<
  typeof kubernetesByocProfileV1Schema
>;

export type KubernetesByocSupportState =
  | {
      state: "certified";
      profileId: KubernetesCertifiedProfileId;
      reason: null;
    }
  | {
      state: "qualified";
      profileId: KubernetesCertifiedProfileId | null;
      reason: "non_reference_profile" | "certification_evidence_required";
    }
  | {
      state: "unsupported";
      profileId: KubernetesCertifiedProfileId | null;
      reason: "compatibility_failed" | "reference_profile_mismatch";
    };

export type KubernetesByocVerifiedProfileFactsV1 = {
  profileId: KubernetesCertifiedProfileId;
  platform: KubernetesByocProfileV1["platform"];
  edgeMode: KubernetesEdgeV1["mode"];
  evidenceLevel: "isolated_provider" | "pilot" | "production";
  evidenceRef: string;
};

export const KUBERNETES_CERTIFIED_PROFILES = {
  "gke-gateway-v1": {
    distribution: "gke",
    computeProfile: "standard",
    networkPolicyProvider: "gke_dataplane_v2",
    storageCsiDriver: "pd.csi.storage.gke.io",
    snapshotCsiDriver: "pd.csi.storage.gke.io",
    edgeController: "gke_gateway",
    edgeMode: "gateway_api",
  },
  "eks-ingress-v1": {
    distribution: "eks",
    computeProfile: "managed_nodes",
    networkPolicyProvider: "vpc_cni_network_policy",
    storageCsiDriver: "ebs.csi.aws.com",
    snapshotCsiDriver: "ebs.csi.aws.com",
    edgeController: "aws_load_balancer_controller",
    edgeMode: "ingress",
  },
} as const satisfies Record<
  KubernetesCertifiedProfileId,
  {
    distribution: KubernetesByocProfileV1["platform"]["distribution"];
    computeProfile: string;
    networkPolicyProvider: string;
    storageCsiDriver: string;
    snapshotCsiDriver: string;
    edgeController: string;
    edgeMode: KubernetesEdgeV1["mode"];
  }
>;

export function parseKubernetesByocProfileV1(value: unknown) {
  return kubernetesByocProfileV1Schema.parse(value);
}

export function resolveKubernetesByocSupportState(input: {
  profile: KubernetesByocProfileV1;
  compatible: boolean;
  verifiedFacts?: KubernetesByocVerifiedProfileFactsV1 | undefined;
}): KubernetesByocSupportState {
  const profileId = input.profile.selectedCertificationProfile;
  if (!input.compatible) {
    return { state: "unsupported", profileId, reason: "compatibility_failed" };
  }
  if (profileId === null) {
    return {
      state: "qualified",
      profileId: null,
      reason: "non_reference_profile",
    };
  }
  const certified = KUBERNETES_CERTIFIED_PROFILES[profileId];
  const configuredFactsMatch =
    input.profile.platform.distribution === certified.distribution &&
    input.profile.platform.computeProfile === certified.computeProfile &&
    input.profile.platform.networkPolicyProvider ===
      certified.networkPolicyProvider &&
    input.profile.platform.storageCsiDriver === certified.storageCsiDriver &&
    input.profile.platform.snapshotCsiDriver === certified.snapshotCsiDriver &&
    input.profile.platform.edgeController === certified.edgeController &&
    input.profile.edge.mode === certified.edgeMode &&
    input.profile.encryptionAttestations.persistentVolumes.encryption ===
      "provider_attested" &&
    input.profile.encryptionAttestations.kubernetesSecrets.encryption ===
      "provider_attested";
  if (!configuredFactsMatch) {
    return {
      state: "unsupported",
      profileId,
      reason: "reference_profile_mismatch",
    };
  }
  const verified = input.verifiedFacts;
  const verifiedFactsMatch =
    verified?.profileId === profileId &&
    verified.edgeMode === certified.edgeMode &&
    verified.platform.distribution === certified.distribution &&
    verified.platform.computeProfile === certified.computeProfile &&
    verified.platform.networkPolicyProvider ===
      certified.networkPolicyProvider &&
    verified.platform.storageCsiDriver === certified.storageCsiDriver &&
    verified.platform.snapshotCsiDriver === certified.snapshotCsiDriver &&
    verified.platform.edgeController === certified.edgeController &&
    verified.evidenceRef.trim().length > 0;
  return verifiedFactsMatch
    ? { state: "certified", profileId, reason: null }
    : {
        state: "qualified",
        profileId,
        reason: "certification_evidence_required",
      };
}

export function profileHasRequiredEncryptionAttestations(
  profile: KubernetesByocProfileV1,
) {
  return (
    profile.encryptionAttestations.persistentVolumes.encryption ===
      "provider_attested" &&
    profile.encryptionAttestations.kubernetesSecrets.encryption ===
      "provider_attested"
  );
}
