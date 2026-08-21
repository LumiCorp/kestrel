import { createHash } from "node:crypto";
import { z } from "zod";

export const KUBERNETES_BYOC_PROOF_VERSION = "kubernetes-byoc-proof-v1" as const;
export const SUPPORTED_CONNECTOR_COMMAND_VERSION =
  "infrastructure-connector-command-v1" as const;
export const SUPPORTED_CONNECTOR_RESULT_VERSION =
  "infrastructure-connector-result-v1" as const;

export const kubernetesProofEvidenceClasses = [
  "hermetic",
  "isolated_provider",
  "pilot",
  "production",
] as const;
export type KubernetesProofEvidenceClass =
  (typeof kubernetesProofEvidenceClasses)[number];

export const kubernetesProofProfiles = ["gke", "eks", "qualified"] as const;
export type KubernetesProofProfile = (typeof kubernetesProofProfiles)[number];

export const kubernetesProofScenarioIds = [
  "connector.qualification",
  "environment.idempotency",
  "environment.resources",
  "routing.public_boundary",
  "routing.signed_execution",
  "routing.isolation",
  "workspace.persistence",
  "workspace.image_update",
  "workspace.rollback",
  "workspace.snapshot_restore",
  "recovery.replay",
  "recovery.eviction",
  "reconciliation.idempotency",
  "cleanup.environment",
] as const;
export type KubernetesProofScenarioId =
  (typeof kubernetesProofScenarioIds)[number];

const identifier = z.string().trim().min(1).max(255);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const evidenceClass = z.enum(kubernetesProofEvidenceClasses);
const profile = z.enum(kubernetesProofProfiles);
const artifactAttestation = z
  .object({
    signature: identifier,
    provenance: identifier,
  })
  .strict();

const resourceObservation = z
  .object({
    kind: identifier,
    name: identifier,
    namespace: identifier.optional(),
    uid: identifier.optional(),
    generation: z.number().int().nonnegative().optional(),
    conditions: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
  })
  .strict();

const scenario = z
  .object({
    id: z.enum(kubernetesProofScenarioIds),
    status: z.enum(["passed", "failed", "blocked", "not_run"]),
    evidenceClass,
    startedAt: timestamp,
    completedAt: timestamp,
    operationIds: z.array(identifier).max(100).default([]),
    commandIds: z.array(identifier).max(100).default([]),
    requestIds: z.array(identifier).max(100).default([]),
    auditIds: z.array(identifier).max(100).default([]),
    desiredRevision: identifier.optional(),
    resources: z.array(resourceObservation).max(200).default([]),
    assertions: z
      .array(
        z
          .object({
            name: identifier,
            passed: z.boolean(),
            detail: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Date(value.completedAt) < new Date(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Scenario completedAt must not precede startedAt.",
      });
    }
    if (value.status === "passed" && value.assertions.some((assertion) => !assertion.passed)) {
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "Passed scenarios cannot contain failed assertions.",
      });
    }
  });

export const kubernetesProofScenarioSchema = scenario;

const cleanup = z
  .object({
    startedAt: timestamp,
    completedAt: timestamp,
    status: z.enum(["passed", "failed"]),
    deletedKestrelResources: z.array(identifier).max(500),
    retainedCustomerResources: z.array(identifier).max(500),
    residualKestrelResources: z.array(identifier).max(500),
    unknownResources: z.array(identifier).max(500),
    assertions: z
      .array(
        z
          .object({
            name: identifier,
            passed: z.boolean(),
            detail: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Date(value.completedAt) < new Date(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Cleanup completedAt must not precede startedAt.",
      });
    }
    if (value.residualKestrelResources.length || value.unknownResources.length) {
      context.addIssue({
        code: "custom",
        path: ["residualKestrelResources"],
        message: "Proof artifacts cannot contain residual or unknown Kestrel resources.",
      });
    }
  });

const proofSchema = z
  .object({
    contract: z.literal(KUBERNETES_BYOC_PROOF_VERSION),
    proofId: z.string().uuid(),
    recordedAt: timestamp,
    codeRevision: identifier,
    profile,
    evidenceClass,
    connectorImageDigest: digest,
    helmChartDigest: digest,
    connectorImageAttestation: artifactAttestation,
    helmChartAttestation: artifactAttestation,
    connectorVersion: identifier,
    commandContract: z.literal(SUPPORTED_CONNECTOR_COMMAND_VERSION),
    resultContract: z.literal(SUPPORTED_CONNECTOR_RESULT_VERSION),
    organizationIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    connectionIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    environmentIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workspaceIdHash: z.string().regex(/^[a-f0-9]{64}$/u),
    qualificationExpiresAt: timestamp,
    platform: z
      .object({
        kubernetesVersion: identifier,
        distribution: z.enum(["gke", "eks", "kind", "other"]),
        edgeMode: z.enum(["gateway_api", "ingress"]),
        edgeController: identifier,
        cni: identifier,
        storageCsi: identifier,
        snapshotCsi: identifier,
        networkPolicy: identifier,
      })
      .strict(),
    scenarios: z.array(scenario).min(kubernetesProofScenarioIds.length).max(32),
    cleanup,
    passed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.scenarios.map((item) => item.id);
    const expected = new Set(kubernetesProofScenarioIds);
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "id"],
          message: `Duplicate scenario '${id}'.`,
        });
      }
      seen.add(id);
    }
    for (const required of expected) {
      if (!seen.has(required)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios"],
          message: `Missing required scenario '${required}'.`,
        });
      }
    }
    if (value.profile === "gke" && value.platform.edgeMode !== "gateway_api") {
      context.addIssue({
        code: "custom",
        path: ["platform", "edgeMode"],
        message: "GKE certification requires Gateway API.",
      });
    }
    if (value.profile === "eks" && value.platform.edgeMode !== "ingress") {
      context.addIssue({
        code: "custom",
        path: ["platform", "edgeMode"],
        message: "EKS certification requires Ingress.",
      });
    }
    if (value.scenarios.some((item) => item.status === "not_run")) {
      context.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "Required proof cannot contain not_run scenarios.",
      });
    }
    const evidenceRank = evidenceClassRank(value.evidenceClass);
    if (value.scenarios.some((item) => evidenceClassRank(item.evidenceClass) > evidenceRank)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "Scenario evidence class cannot exceed the proof evidence class.",
      });
    }
    const scenarioPassed = value.scenarios.every((item) => item.status === "passed");
    const cleanupPassed = value.cleanup.status === "passed" &&
      value.cleanup.residualKestrelResources.length === 0 &&
      value.cleanup.unknownResources.length === 0;
    if (value.passed !== (scenarioPassed && cleanupPassed)) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed must exactly reflect scenario and cleanup success.",
      });
    }
  });

export type KubernetesByocProof = z.infer<typeof proofSchema>;
export type KubernetesProofScenario = z.infer<typeof scenario>;

export function parseKubernetesByocProof(
  input: unknown,
  options: { now?: Date } = {},
): KubernetesByocProof {
  const proof = proofSchema.parse(input);
  const now = options.now ?? new Date();
  if (new Date(proof.qualificationExpiresAt) <= now) {
    throw new Error("Kubernetes qualification has expired.");
  }
  return proof;
}

export function redactKubernetesProofIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evidenceClassRank(value: KubernetesProofEvidenceClass): number {
  return kubernetesProofEvidenceClasses.indexOf(value);
}

export function proofScenario(
  id: KubernetesProofScenarioId,
  input: Omit<KubernetesProofScenario, "id">,
): KubernetesProofScenario {
  return scenario.parse({ id, ...input });
}

export function requiredKubernetesProofScenarioIds(
  _profile: KubernetesProofProfile,
): readonly KubernetesProofScenarioId[] {
  return kubernetesProofScenarioIds;
}
