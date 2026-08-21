import { z } from "zod";
import {
  ENVIRONMENT_PROVIDER_KINDS,
  ENVIRONMENT_RESOURCE_ROLES,
  environmentPlacementSchema,
  environmentProviderEvidenceSchema,
} from "./providers/contracts-v2";
import { kubernetesConnectionConfigV1Schema } from "./kubernetes-connector-contracts";
import { kubernetesByocProfileV1Schema } from "./providers/kubernetes-byoc-profile";

const identifierSchema = z.string().trim().min(1).max(255);

export const kubernetesPendingConnectionV1Schema = z
  .object({ contract: z.literal("kubernetes-pending-connection-v1") })
  .strict();

export const flyProviderConnectionConfigurationV1Schema = z
  .object({
    contract: z.literal("fly-connection-configuration-v1"),
    organizationSlug: z.string().trim().min(1).max(120).nullable(),
  })
  .strict();

export const environmentProviderConnectionConfigurationSchema =
  z.discriminatedUnion("contract", [
    flyProviderConnectionConfigurationV1Schema,
    kubernetesPendingConnectionV1Schema,
    kubernetesConnectionConfigV1Schema,
    kubernetesByocProfileV1Schema,
  ]);

export const environmentProviderQualificationEvidenceSchema = z
  .array(environmentProviderEvidenceSchema)
  .max(256);

export const environmentProviderResourceMetadataV1Schema = z
  .object({
    contract: z.literal("provider-resource-metadata-v1"),
    source: z.enum([
      "legacy_backfill",
      "legacy_dual_write",
      "read_repair",
      "provider_observation",
    ]),
    detail: z.string().trim().min(1).max(500).optional(),
    requestedCpu: z.number().positive().max(1024).nullable().optional(),
    requestedMemoryMb: z.number().int().positive().max(4_194_304).nullable().optional(),
    requestedStorageGb: z.number().int().positive().max(1_048_576).nullable().optional(),
    imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/u).nullable().optional(),
    placement: z.record(
      z.string().trim().min(1).max(120),
      z.string().trim().min(1).max(500),
    ).nullable().optional(),
    conditions: z.array(
      z.object({
        type: z.string().trim().min(1).max(120),
        status: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(1).max(160).optional(),
        message: z.string().trim().min(1).max(500).optional(),
      }).strict(),
    ).max(64).optional(),
  })
  .strict();

export const environmentProviderResourceWriteSchema = z
  .object({
    organizationId: identifierSchema,
    environmentId: identifierSchema,
    workspaceId: identifierSchema.nullable(),
    replacementId: identifierSchema.nullable().default(null),
    providerConnectionId: identifierSchema,
    provider: z.enum(ENVIRONMENT_PROVIDER_KINDS),
    resourceRole: z.enum(ENVIRONMENT_RESOURCE_ROLES),
    externalId: identifierSchema,
    providerUid: identifierSchema.nullable().default(null),
    desiredRevision: identifierSchema,
    observedGeneration: identifierSchema.nullable().default(null),
    state: z.string().trim().min(1).max(120).nullable().default(null),
    providerMetadata: environmentProviderResourceMetadataV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const workspaceRole =
      value.resourceRole === "workspace_compute" ||
      value.resourceRole === "workspace_storage" ||
      value.resourceRole === "snapshot";
    if (workspaceRole !== (value.workspaceId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["workspaceId"],
        message: `${value.resourceRole} has an invalid workspace scope.`,
      });
    }
    if (
      value.replacementId !== null &&
      (value.workspaceId === null ||
        (value.resourceRole !== "workspace_compute" &&
          value.resourceRole !== "workspace_storage"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["replacementId"],
        message:
          "Replacement identity is limited to workspace compute and storage resources.",
      });
    }
  });

export const infrastructureConnectorEventV1Schema = z
  .object({
    contract: z.literal("infrastructure-connector-event-v1"),
    commandId: identifierSchema,
    sequence: z.number().int().positive(),
    type: z.enum(["progress", "condition", "warning"]),
    state: z.string().trim().min(1).max(120).optional(),
    message: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const connectorVersionListSchema = z
  .array(identifierSchema)
  .min(1)
  .max(32)
  .transform((versions) => [...new Set(versions)]);

export const environmentProviderPlacementPersistenceSchema =
  environmentPlacementSchema;

export type EnvironmentProviderConnectionConfiguration = z.infer<
  typeof environmentProviderConnectionConfigurationSchema
>;
export type EnvironmentProviderResourceWrite = z.input<
  typeof environmentProviderResourceWriteSchema
>;
export type InfrastructureConnectorEventV1 = z.infer<
  typeof infrastructureConnectorEventV1Schema
>;

export function parseEnvironmentProviderConnectionConfiguration(
  value: unknown,
) {
  return environmentProviderConnectionConfigurationSchema.parse(value);
}

export function parseEnvironmentProviderQualificationEvidence(value: unknown) {
  return environmentProviderQualificationEvidenceSchema.parse(value);
}

export function parseEnvironmentProviderResourceMetadata(value: unknown) {
  return value === null
    ? null
    : environmentProviderResourceMetadataV1Schema.parse(value);
}
