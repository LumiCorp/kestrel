import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  extractAttachmentTextIsolated,
  isAttachmentTextExtractable,
} from "@kestrel-agents/files";
import sharp from "sharp";

import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import { resolveLocalCorePaths } from "./home.js";

export const DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const DESKTOP_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES = 500 * 1024 * 1024;
export const DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INLINE_TEXT_BYTES = 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

export interface DesktopAttachmentMetadata {
  fileId: string;
  /** @deprecated Compatibility alias for fileId. */
  attachmentId: string;
  threadId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: "image" | "text" | "file";
  declaredMimeType?: string | undefined;
  detectedMimeType: string;
  lifecycleState: "draft" | "ready" | "quarantined" | "failed" | "deleted";
  representationStatus: "native_image" | "extracted_text" | "staged_file" | "metadata_only";
  metadataOnlyReason?: string | undefined;
  createdAt: string;
  submittedAt?: string | undefined;
  messageId?: string | undefined;
  messageIds?: string[] | undefined;
}

interface AttachmentIndexV2 {
  version: "desktop-attachments-v2";
  attachments: DesktopAttachmentMetadata[];
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv", ".ts", ".tsx", ".js", ".jsx",
  ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cc",
  ".cpp", ".cxx", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql", ".html", ".css",
  ".scss", ".less", ".xml", ".toml", ".ini", ".cfg", ".conf", ".env", ".graphql", ".gql", ".vue", ".svelte",
]);

export class DesktopAttachmentStore {
  private readonly rootPath: string;
  private readonly blobPath: string;
  private readonly indexPath: string;
  private mutation = Promise.resolve();

  constructor(homePath: string) {
    this.rootPath = path.join(resolveLocalCorePaths(homePath).stateRootPath, "attachments");
    this.blobPath = path.join(this.rootPath, "blobs");
    this.indexPath = path.join(this.rootPath, "index.json");
  }

  async import(input: {
    threadId: string;
    filename: string;
    data: Buffer;
    mimeType?: string | undefined;
    sha256?: string | undefined;
    now?: Date | undefined;
  }): Promise<DesktopAttachmentMetadata> {
    return this.withMutation(async () => {
      const threadId = requireNonEmpty(input.threadId, "threadId");
      const filename = sanitizeFilename(input.filename);
      const validation = validateAttachment(filename, input.data, input.mimeType);
      const sha256 = createHash("sha256").update(input.data).digest("hex");
      if (input.sha256 !== undefined && input.sha256.toLowerCase() !== sha256) {
        throw new Error("Attachment hash does not match its contents.");
      }
      const index = await this.readIndex();
      const createdAt = (input.now ?? new Date()).toISOString();
      const fileId = `file-${randomUUID()}`;
      const metadata: DesktopAttachmentMetadata = {
        fileId,
        attachmentId: fileId,
        threadId,
        filename,
        mimeType: validation.mimeType,
        ...(input.mimeType !== undefined ? { declaredMimeType: input.mimeType } : {}),
        detectedMimeType: validation.mimeType,
        sizeBytes: input.data.byteLength,
        sha256,
        kind: validation.kind,
        lifecycleState: "ready",
        representationStatus: validation.representationStatus,
        ...(validation.metadataOnlyReason !== undefined
          ? { metadataOnlyReason: validation.metadataOnlyReason }
          : {}),
        createdAt,
      };
      await mkdir(this.blobPath, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.blobPath, sha256), input.data, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await this.writeIndex({ ...index, attachments: [...index.attachments, metadata] });
      return metadata;
    });
  }

  async importPath(input: {
    threadId: string;
    filename: string;
    sourcePath: string;
    mimeType?: string | undefined;
    now?: Date | undefined;
  }): Promise<DesktopAttachmentMetadata> {
    const sourceInfo = await lstat(input.sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error("Only regular files can be attached.");
    }
    if (sourceInfo.size > DESKTOP_MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment exceeds the 100 MiB limit.");
    }
    return this.withMutation(async () => {
      const threadId = requireNonEmpty(input.threadId, "threadId");
      const filename = sanitizeFilename(input.filename);
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
      await mkdir(this.blobPath, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.rootPath, `import-${randomUUID()}.tmp`);
      try {
        await copyFile(input.sourcePath, temporary, constants.COPYFILE_EXCL);
        const copiedInfo = await stat(temporary);
        if (!copiedInfo.isFile() || copiedInfo.size > DESKTOP_MAX_ATTACHMENT_BYTES) {
          throw new Error("Attachment exceeds the 100 MiB limit.");
        }
        const handle = await open(temporary, "r");
        const sample = Buffer.alloc(Math.min(copiedInfo.size, 64 * 1024));
        try {
          await handle.read(sample, 0, sample.byteLength, 0);
        } finally {
          await handle.close();
        }
        const validation = validateAttachmentSample(filename, sample, copiedInfo.size, input.mimeType);
        const sha256 = await sha256File(temporary);
        const blobFile = path.join(this.blobPath, sha256);
        await link(temporary, blobFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const index = await this.readIndex();
        const createdAt = (input.now ?? new Date()).toISOString();
        const fileId = `file-${randomUUID()}`;
        const metadata: DesktopAttachmentMetadata = {
          fileId,
          attachmentId: fileId,
          threadId,
          filename,
          mimeType: validation.mimeType,
          ...(input.mimeType !== undefined ? { declaredMimeType: input.mimeType } : {}),
          detectedMimeType: validation.mimeType,
          sizeBytes: copiedInfo.size,
          sha256,
          kind: validation.kind,
          lifecycleState: "ready",
          representationStatus: validation.representationStatus,
          ...(validation.metadataOnlyReason ? { metadataOnlyReason: validation.metadataOnlyReason } : {}),
          createdAt,
        };
        await this.writeIndex({ ...index, attachments: [...index.attachments, metadata] });
        return metadata;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async list(threadId: string): Promise<DesktopAttachmentMetadata[]> {
    const normalized = requireNonEmpty(threadId, "threadId");
    return (await this.readIndex()).attachments
      .filter((entry) => entry.threadId === normalized)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async remove(threadId: string, attachmentId: string): Promise<boolean> {
    return this.withMutation(async () => {
      const index = await this.readIndex();
      const found = index.attachments.find((entry) => entry.attachmentId === attachmentId && entry.threadId === threadId);
      if (found === undefined) return false;
      if ((found.messageIds?.length ?? 0) > 0 || found.submittedAt !== undefined) {
        throw new Error("Files attached to a message cannot be removed from the Thread.");
      }
      const attachments = index.attachments.filter((entry) => entry !== found);
      await this.writeIndex({ ...index, attachments });
      if (attachments.every((entry) => entry.sha256 !== found.sha256)) {
        await rm(path.join(this.blobPath, found.sha256), { force: true });
      }
      return true;
    });
  }

  async resolve(threadId: string, attachmentIds: string[]): Promise<RunTurnAttachment[]> {
    if (attachmentIds.length > DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`A message can include at most ${DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error("Attachment IDs must be unique.");
    return this.withMutation(async () => {
      const index = await this.readIndex();
      const entries = attachmentIds.map((attachmentId) => {
        const entry = index.attachments.find((candidate) => candidate.fileId === attachmentId || candidate.attachmentId === attachmentId);
        if (entry === undefined || entry.threadId !== threadId) {
          throw new Error(`Attachment '${attachmentId}' is unavailable for this thread.`);
        }
        return entry;
      });
      const total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      if (total > DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the per-message total size limit.");
      const resolved = await Promise.all(entries.map(async (entry) => {
        const blobFile = path.join(this.blobPath, entry.sha256);
        const actualHash = await sha256File(blobFile);
        if (actualHash !== entry.sha256) {
          throw new Error(`Attachment '${entry.attachmentId}' failed integrity validation.`);
        }
        const inlineBytes = entry.kind === "text" ? await readFile(blobFile) : undefined;
        const imageBytes = entry.kind === "image"
          ? await createBoundedImageDerivative(blobFile).catch(() => undefined)
          : undefined;
        let documentText: { text: string; truncated: boolean } | undefined;
        if (entry.kind === "file" && isAttachmentTextExtractable(entry.detectedMimeType)) {
          try {
            const extraction = await extractAttachmentTextIsolated({
              buffer: await readFile(blobFile),
              filename: entry.filename,
              mediaType: entry.detectedMimeType,
              timeoutMs: 30_000,
            });
            if (extraction.text) documentText = extraction;
          } catch {
            documentText = undefined;
          }
        }
        return {
          fileId: entry.fileId,
          attachmentId: entry.attachmentId,
          threadId: entry.threadId,
          filename: entry.filename,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256,
          kind: entry.kind,
          representationStatus: documentText !== undefined ? "extracted_text" : entry.representationStatus,
          createdAt: entry.createdAt,
          path: blobFile,
          ...(entry.metadataOnlyReason !== undefined ? { metadataOnlyReason: entry.metadataOnlyReason } : {}),
          ...(entry.kind === "image" && imageBytes !== undefined
            ? { data: imageBytes.toString("base64") }
            : entry.kind === "text" && inlineBytes !== undefined
              ? {
                  text: new TextDecoder("utf-8", { fatal: true }).decode(inlineBytes.subarray(0, MAX_INLINE_TEXT_BYTES)),
                  ...(inlineBytes.byteLength > MAX_INLINE_TEXT_BYTES ? { textTruncated: true } : {}),
                }
              : {}),
          ...(documentText !== undefined
            ? { text: documentText.text, ...(documentText.truncated ? { textTruncated: true } : {}) }
            : {}),
        } satisfies RunTurnAttachment;
      }));
      return resolved;
    });
  }

  async markSubmitted(threadId: string, attachmentIds: string[], messageId: string): Promise<void> {
    await this.withMutation(async () => {
      const index = await this.readIndex();
      const selected = new Set(attachmentIds);
      if (selected.size !== attachmentIds.length) throw new Error("Attachment IDs must be unique.");
      for (const attachmentId of attachmentIds) {
        const entry = index.attachments.find((candidate) => candidate.fileId === attachmentId || candidate.attachmentId === attachmentId);
        if (entry === undefined || entry.threadId !== threadId) {
          throw new Error(`Attachment '${attachmentId}' is unavailable for this thread.`);
        }
      }
      const submittedAt = new Date().toISOString();
      await this.writeIndex({
        ...index,
        attachments: index.attachments.map((entry) => (selected.has(entry.fileId) || selected.has(entry.attachmentId)) && entry.threadId === threadId
          ? {
              ...entry,
              lifecycleState: "ready" as const,
              submittedAt: entry.submittedAt ?? submittedAt,
              messageId,
              messageIds: [...new Set([...(entry.messageIds ?? []), messageId])],
            }
          : entry),
      });
    });
  }

  async cleanup(now = new Date()): Promise<number> {
    return this.withMutation(async () => {
      const index = await this.readIndex();
      const cutoff = now.getTime() - DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS;
      const removed = index.attachments.filter((entry) => entry.submittedAt === undefined && Date.parse(entry.createdAt) < cutoff);
      if (removed.length === 0) return 0;
      const attachments = index.attachments.filter((entry) => removed.includes(entry) === false);
      await this.writeIndex({ ...index, attachments });
      const retainedHashes = new Set(attachments.map((entry) => entry.sha256));
      await Promise.all([...new Set(removed.map((entry) => entry.sha256))]
        .filter((sha256) => retainedHashes.has(sha256) === false)
        .map(async (sha256) => await rm(path.join(this.blobPath, sha256), { force: true })));
      return removed.length;
    });
  }

  private async readIndex(): Promise<AttachmentIndexV2> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Desktop attachment index is invalid.");
      const record = parsed as Record<string, unknown>;
      if ((record.version !== "desktop-attachments-v1" && record.version !== "desktop-attachments-v2") || Array.isArray(record.attachments) === false) {
        throw new Error("Desktop attachment index version is invalid.");
      }
      return {
        version: "desktop-attachments-v2",
        attachments: record.attachments.map(parseAttachmentMetadata),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: "desktop-attachments-v2", attachments: [] };
      throw error;
    }
  }

  private async writeIndex(index: AttachmentIndexV2): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.indexPath);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function parseAttachmentMetadata(value: unknown): DesktopAttachmentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Desktop attachment metadata is invalid.");
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "image" && kind !== "text" && kind !== "file") throw new Error("Desktop attachment kind is invalid.");
  const sizeBytes = record.sizeBytes;
  if (typeof sizeBytes !== "number" || Number.isSafeInteger(sizeBytes) === false || sizeBytes < 0) throw new Error("Desktop attachment size is invalid.");
  const sha256 = requireNonEmpty(String(record.sha256 ?? ""), "sha256").toLowerCase();
  if (/^[a-f0-9]{64}$/u.test(sha256) === false) throw new Error("Desktop attachment hash is invalid.");
  const createdAt = requireNonEmpty(String(record.createdAt ?? ""), "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("Desktop attachment creation time is invalid.");
  const submittedAt = typeof record.submittedAt === "string" ? record.submittedAt : undefined;
  const messageId = typeof record.messageId === "string" ? requireNonEmpty(record.messageId, "messageId") : undefined;
  if (submittedAt !== undefined && Number.isNaN(Date.parse(submittedAt))) throw new Error("Desktop attachment submission time is invalid.");
  const detectedMimeType = typeof record.detectedMimeType === "string"
    ? requireNonEmpty(record.detectedMimeType, "detectedMimeType")
    : requireNonEmpty(String(record.mimeType ?? ""), "mimeType");
  const representationStatus = record.representationStatus === "native_image"
    || record.representationStatus === "extracted_text"
    || record.representationStatus === "staged_file"
    || record.representationStatus === "metadata_only"
    ? record.representationStatus
    : kind === "image" ? "native_image" : kind === "text" ? "extracted_text" : "metadata_only";
  return {
    fileId: requireNonEmpty(String(record.fileId ?? record.attachmentId ?? ""), "fileId"),
    attachmentId: requireNonEmpty(String(record.attachmentId ?? record.fileId ?? ""), "attachmentId"),
    threadId: requireNonEmpty(String(record.threadId ?? ""), "threadId"),
    filename: sanitizeFilename(String(record.filename ?? "")),
    mimeType: requireNonEmpty(String(record.mimeType ?? ""), "mimeType"),
    sizeBytes,
    sha256,
    kind,
    ...(typeof record.declaredMimeType === "string" ? { declaredMimeType: record.declaredMimeType } : {}),
    detectedMimeType,
    lifecycleState: record.lifecycleState === "draft"
      || record.lifecycleState === "quarantined"
      || record.lifecycleState === "failed"
      || record.lifecycleState === "deleted"
      ? record.lifecycleState
      : "ready",
    representationStatus,
    ...(typeof record.metadataOnlyReason === "string" ? { metadataOnlyReason: record.metadataOnlyReason } : {}),
    createdAt,
    ...(submittedAt !== undefined ? { submittedAt } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(Array.isArray(record.messageIds)
      ? { messageIds: record.messageIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) }
      : messageId !== undefined ? { messageIds: [messageId] } : {}),
  };
}

function validateAttachment(filename: string, data: Buffer, claimedMime?: string): {
  kind: "image" | "text" | "file";
  mimeType: string;
  representationStatus: DesktopAttachmentMetadata["representationStatus"];
  metadataOnlyReason?: string | undefined;
} {
  if (data.byteLength > DESKTOP_MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds the 100 MiB limit.");
  const imageMime = detectImageMime(data);
  if (imageMime !== undefined) {
    return { kind: "image", mimeType: imageMime, representationStatus: "native_image" };
  }
  const extension = path.extname(filename).toLowerCase();
  const normalizedMime = claimedMime?.split(";", 1)[0]?.trim().toLowerCase();
  const textMime = normalizedMime?.startsWith("text/") === true
    || normalizedMime === "application/json" || normalizedMime === "application/yaml" || normalizedMime === "application/x-yaml";
  if (data.includes(0) === false) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (TEXT_EXTENSIONS.has(extension) || textMime) {
        return {
          kind: "text",
          mimeType: normalizedMime && normalizedMime !== "application/octet-stream" ? normalizedMime : "text/plain",
          representationStatus: "extracted_text",
        };
      }
    } catch { /* Preserve invalid UTF-8 as an opaque file. */ }
  }
  const detected = detectBinaryMime(data, filename, normalizedMime) ?? (normalizedMime && normalizedMime !== "application/octet-stream"
    ? normalizedMime
    : "application/octet-stream");
  return {
    kind: "file",
    mimeType: detected,
    representationStatus: isAttachmentTextExtractable(detected) ? "staged_file" : "metadata_only",
    ...(isAttachmentTextExtractable(detected)
      ? {}
      : { metadataOnlyReason: "No automatic interpreter is available; the original is staged read-only for tools." }),
  };
}

function validateAttachmentSample(
  filename: string,
  sample: Buffer,
  sizeBytes: number,
  claimedMime?: string,
): ReturnType<typeof validateAttachment> {
  if (sizeBytes > DESKTOP_MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds the 100 MiB limit.");
  const imageMime = detectImageMime(sample);
  if (imageMime) return { kind: "image", mimeType: imageMime, representationStatus: "native_image" };
  const normalizedMime = claimedMime?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  if (
    TEXT_EXTENSIONS.has(extension)
    || normalizedMime?.startsWith("text/")
    || ["application/json", "application/yaml", "application/x-yaml"].includes(normalizedMime ?? "")
  ) {
    return {
      kind: "text",
      mimeType: normalizedMime && normalizedMime !== "application/octet-stream" ? normalizedMime : "text/plain",
      representationStatus: "extracted_text",
    };
  }
  const detected = detectBinaryMime(sample, filename, normalizedMime) ?? (
    normalizedMime && normalizedMime !== "application/octet-stream" ? normalizedMime : "application/octet-stream"
  );
  return {
    kind: "file",
    mimeType: detected,
    representationStatus: isAttachmentTextExtractable(detected) ? "staged_file" : "metadata_only",
    ...(isAttachmentTextExtractable(detected) ? {} : {
      metadataOnlyReason: "No automatic interpreter is available; the original is staged read-only for tools.",
    }),
  };
}

function detectImageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const header = data.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return;
}

function detectBinaryMime(data: Buffer, filename: string, claimedMime?: string): string | undefined {
  if (data.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const office = [
      [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ] as const;
    return office.find(([extension, mediaType]) =>
      filename.toLowerCase().endsWith(extension) || claimedMime === mediaType
    )?.[1] ?? "application/zip";
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF") return "application/octet-stream";
  if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "application/x-executable";
  if (data.subarray(0, 4).equals(Buffer.from([0xcf, 0x11, 0xe0, 0xa1]))) return "application/x-ole-storage";
  return undefined;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function createBoundedImageDerivative(filePath: string): Promise<Buffer> {
  const derivative = await sharp(filePath, { animated: false })
    .rotate()
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .toBuffer();
  if (derivative.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new Error("The safe image derivative remains too large for native model input.");
  }
  return derivative;
}

function sanitizeFilename(value: string): string {
  const filename = path.basename(requireNonEmpty(value, "filename"));
  if (filename === "." || filename === "..") throw new Error("Attachment filename is invalid.");
  return filename.slice(0, 240);
}
function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Attachment ${field} must be a non-empty string.`);
  return value.trim();
}
