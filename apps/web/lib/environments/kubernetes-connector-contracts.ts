import { createHash } from "node:crypto";
import { z } from "zod";
import { kubernetesByocProfileV1Schema } from "./providers/kubernetes-byoc-profile";

const identifier = z.string().trim().min(1).max(255);
const digestImage = z.string().regex(/@sha256:[a-f0-9]{64}$/u);

export const kubernetesConnectorEnrollmentSchema = z
  .object({
    connectorName: identifier,
    connectorVersion: identifier,
    signingPublicKey: z.string().trim().min(64).max(8192),
    encryptionPublicKey: z.string().trim().min(32).max(8192),
    commandVersions: z.array(identifier).min(1).max(32),
    resultVersions: z.array(identifier).min(1).max(32),
    clusterMetadata: z
      .object({ identityId: identifier })
      .strict(),
  })
  .strict();

export const kubernetesConnectionConfigV1Schema = z
  .object({
    contract: z.literal("kubernetes-connection-config-v1"),
    displayName: identifier,
    isDefault: z.boolean(),
    profile: kubernetesByocProfileV1Schema,
    runtimeTemplateAllowlist: z.array(identifier).min(1).max(32),
    qualificationProbeImage: digestImage,
    attestationEvidenceNote: z.string().trim().min(1).max(500),
  })
  .strict();

export type KubernetesConnectionConfigV1 = z.infer<
  typeof kubernetesConnectionConfigV1Schema
>;

export const KUBERNETES_QUALIFICATION_CHECK_IDS = [
  "discovery.version",
  "discovery.resources",
  "authorization.exact_verbs",
  "prerequisite.storage_class",
  "prerequisite.snapshot_class",
  "prerequisite.edge",
  "active.baseline",
  "active.image_pull_and_schedule",
  "active.pvc_persistence",
  "active.snapshot_restore",
  "active.edge_route",
  "active.public_dns_tls",
  "active.allowed_network_paths",
  "active.denied_network_paths",
  "active.quota_rejection",
  "cleanup.namespace_removed",
] as const;

const qualificationCheckSchema = z
  .object({
    id: z.enum(KUBERNETES_QUALIFICATION_CHECK_IDS),
    status: z.enum(["passed", "failed", "blocked", "not_run"]),
    evidenceClass: z.enum(["cluster_preflight", "isolated_provider"]),
    detail: z.string().trim().min(1).max(500),
    observedVersion: z.string().trim().min(1).max(120).optional(),
    auditId: identifier.optional(),
  })
  .strict();

export const kubernetesQualificationReportV1Schema = z
  .object({
    contract: z.literal("kubernetes-qualification-report-v1"),
    runId: identifier,
    connectionId: identifier,
    configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    clusterFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceClass: z.literal("isolated_provider"),
    observed: z
      .object({
        kubernetesVersion: identifier,
        distribution: z.enum(["gke", "eks", "other"]),
        storageDriver: identifier,
        snapshotDriver: identifier,
        edgeController: identifier,
        edgeMode: z.enum(["gateway_api", "ingress"]),
      })
      .strict(),
    checks: z.array(qualificationCheckSchema).length(
      KUBERNETES_QUALIFICATION_CHECK_IDS.length,
    ),
    cleanup: z
      .object({
        status: z.enum(["passed", "failed"]),
        namespace: z.string().trim().min(1).max(63),
        residualResources: z.array(identifier).max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const ids = report.checks.map((check) => check.id);
    for (const expected of KUBERNETES_QUALIFICATION_CHECK_IDS) {
      if (ids.filter((id) => id === expected).length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["checks"],
          message: `Qualification must contain exactly one ${expected} result.`,
        });
      }
    }
    if (new Date(report.expiresAt) <= new Date(report.completedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Qualification evidence must expire after completion.",
      });
    }
  });

export type KubernetesQualificationReportV1 = z.infer<
  typeof kubernetesQualificationReportV1Schema
>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function kubernetesConnectionConfigRevision(value: unknown) {
  const config = kubernetesConnectionConfigV1Schema.parse(value);
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

export function qualificationPassed(report: KubernetesQualificationReportV1) {
  return (
    report.cleanup.status === "passed" &&
    report.cleanup.residualResources.length === 0 &&
    report.checks.every((check) => check.status === "passed") &&
    new Date(report.expiresAt) > new Date()
  );
}
