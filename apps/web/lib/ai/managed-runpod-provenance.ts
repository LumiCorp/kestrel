import { z } from "zod";

const managedRunPodRunMetadataSchema = z
  .object({
    providerConnectionId: z.string().trim().min(1).optional(),
  })
  .passthrough();

export type ManagedRunPodRunMetadata = z.infer<
  typeof managedRunPodRunMetadataSchema
>;

export class ManagedRunPodProvenanceError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ManagedRunPodProvenanceError";
    this.code = code;
  }
}

export function parseManagedRunPodRunMetadata(
  value: unknown,
): ManagedRunPodRunMetadata {
  const parsed = managedRunPodRunMetadataSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new ManagedRunPodProvenanceError(
      "MANAGED_RUNPOD_RUN_METADATA_INVALID",
      "Managed RunPod run metadata is invalid.",
    );
  }
  return parsed.data;
}

export function requireManagedRunPodCleanupConnectionId(input: {
  providerConnectionId?: string | null;
  endpointId?: string | null;
  templateId?: string | null;
}) {
  const providerConnectionId = input.providerConnectionId?.trim() || null;
  if (providerConnectionId) return providerConnectionId;
  if (input.endpointId || input.templateId) {
    throw new ManagedRunPodProvenanceError(
      "MANAGED_RUNPOD_RESOURCE_PROVENANCE_MISSING",
      "Managed RunPod resources cannot be deleted because their provider connection provenance is missing.",
    );
  }
  return null;
}
