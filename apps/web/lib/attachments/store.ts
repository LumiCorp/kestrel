import "server-only";

import {
  cleanupExpiredFiles,
  deleteDraftThreadFile,
  getFileByIdForUser,
  getThreadFileForUser,
  initializeThreadFile,
  linkFilesToMessage,
  resolveReadyThreadFiles,
  resolveThreadFilesForExecution,
  uploadThreadFile,
  type FileScanner,
  type FileScanResult,
} from "@/lib/files/service";

export type AttachmentScanResult = FileScanResult;
export type AttachmentScanner = FileScanner;

export function attachmentIdsFromMessageParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    if (record.type !== "data-kestrel-attachment" && record.type !== "data-kestrel-file") return [];
    const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : undefined;
    const fileId = typeof data?.fileId === "string"
      ? data.fileId.trim()
      : typeof data?.attachmentId === "string" ? data.attachmentId.trim() : "";
    if (!fileId) throw new Error("File message part is missing its file ID.");
    return [fileId];
  });
}

export const initializeThreadAttachment = initializeThreadFile;
export const uploadThreadAttachment = (input: Omit<Parameters<typeof uploadThreadFile>[0], "fileId"> & { fileId?: string; attachmentId?: string }) =>
  uploadThreadFile({ ...input, fileId: input.fileId ?? input.attachmentId ?? "" });
export const getThreadAttachmentForUser = (input: Omit<Parameters<typeof getThreadFileForUser>[0], "fileId"> & { fileId?: string; attachmentId?: string }) =>
  getThreadFileForUser({ ...input, fileId: input.fileId ?? input.attachmentId ?? "" });
export const getAttachmentByIdForUser = (input: Omit<Parameters<typeof getFileByIdForUser>[0], "fileId"> & { fileId?: string; attachmentId?: string }) =>
  getFileByIdForUser({ ...input, fileId: input.fileId ?? input.attachmentId ?? "" });
export const deleteDraftThreadAttachment = (input: Omit<Parameters<typeof deleteDraftThreadFile>[0], "fileId"> & { fileId?: string; attachmentId?: string }) =>
  deleteDraftThreadFile({ ...input, fileId: input.fileId ?? input.attachmentId ?? "" });
export const resolveReadyThreadAttachments = (input: Omit<Parameters<typeof resolveReadyThreadFiles>[0], "fileIds"> & { attachmentIds: string[] }) =>
  resolveReadyThreadFiles({ ...input, fileIds: input.attachmentIds });
export const resolveThreadAttachmentsForExecution = (input: Omit<Parameters<typeof resolveThreadFilesForExecution>[0], "fileIds"> & { attachmentIds: string[] }) =>
  resolveThreadFilesForExecution({ ...input, fileIds: input.attachmentIds });
export const submitThreadAttachments = async (input: Omit<Parameters<typeof linkFilesToMessage>[0], "fileIds"> & { attachmentIds: string[] }) => {
  const references = await linkFilesToMessage({ ...input, fileIds: input.attachmentIds });
  return references.map((reference) => ({
    type: "kestrel-attachment" as const,
    attachmentId: reference.fileId,
    fileId: reference.fileId,
    filename: reference.filename,
    sizeBytes: reference.sizeBytes,
    mediaType: reference.mediaType,
    representationKind: reference.representationKind,
    status: reference.status,
  }));
};
export const cleanupExpiredDraftThreadAttachments = cleanupExpiredFiles;
