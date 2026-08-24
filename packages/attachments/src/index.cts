import type { AttachmentTextExtraction } from "./index.js";

export type { AttachmentTextExtraction } from "./index.js";

export const DEFAULT_ATTACHMENT_EXTRACTED_TEXT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_PROCESSOR_INPUT_BYTES = 100 * 1024 * 1024;

const EXTRACTABLE_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/yaml",
]);

export function isAttachmentTextExtractable(mediaType: string): boolean {
  return mediaType.startsWith("text/") || EXTRACTABLE_MEDIA_TYPES.has(mediaType);
}

export async function extractAttachmentText(input: {
  buffer: Buffer;
  filename: string;
  mediaType: string;
  maxTextBytes?: number | undefined;
}): Promise<AttachmentTextExtraction> {
  const attachmentModule = await import("./index.js");
  return attachmentModule.extractAttachmentText(input);
}

export async function extractAttachmentTextIsolated(input: {
  buffer: Buffer;
  filename: string;
  mediaType: string;
  maxTextBytes?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<AttachmentTextExtraction> {
  const attachmentModule = await import("./index.js");
  return attachmentModule.extractAttachmentTextIsolated(input);
}
