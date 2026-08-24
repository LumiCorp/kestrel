import { isAttachmentTextExtractable } from "@kestrel-agents/files";

export const FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON =
  "Inline extraction failed or is unsupported; the original remains available read-only to Workspace tools.";

export type FileRepresentationOutcome =
  | "native_image"
  | "extracted_text"
  | "metadata_only";

export type FileRepresentationFailureCategory =
  | "unsupported_media_type"
  | "extraction_failed"
  | "empty_extraction";

const NATIVE_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isNativeImageRepresentationMediaType(mediaType: string): boolean {
  return NATIVE_IMAGE_MEDIA_TYPES.has(mediaType.trim().toLowerCase());
}

export function modelVisibleMetadataOnlyReason(
  representation: string,
  _internalReason: string | null | undefined,
): string | undefined {
  if (representation !== "metadata_only") return;
  return FILE_INLINE_REPRESENTATION_UNAVAILABLE_REASON;
}

export function isReusableFileRepresentation(input: {
  kind: FileRepresentationOutcome;
  status: "pending" | "ready" | "failed";
  mediaType: string;
}): boolean {
  if (input.status !== "ready") return false;
  if (input.kind !== "metadata_only") return true;
  return isAttachmentTextExtractable(input.mediaType) === false
    && isNativeImageRepresentationMediaType(input.mediaType) === false;
}

export function recordFileRepresentationOutcome(
  input: {
    outcome: FileRepresentationOutcome;
    mediaType: string;
    durationMs: number;
    failureCategory?: FileRepresentationFailureCategory | undefined;
  },
  log: (message: string, facts: Record<string, unknown>) => void = console.info,
): void {
  log("File representation processing outcome.", {
    event: "file_representation_processed",
    outcome: input.outcome,
    mediaType: input.mediaType,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
    ...(input.failureCategory !== undefined
      ? { failureCategory: input.failureCategory }
      : {}),
  });
}
