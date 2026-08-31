import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  CONVERSATION_ATTACHMENT_DRAFT_RETENTION_MS,
  CONVERSATION_ATTACHMENT_MAX_COUNT,
  CONVERSATION_ATTACHMENT_MAX_FILE_BYTES,
  CONVERSATION_ATTACHMENT_MAX_TURN_BYTES,
  type ConversationAttachmentReference,
  type ConversationFileReference,
} from "@kestrel-agents/conversation";
import type { RunnerTurnAttachment } from "@kestrel-agents/protocol";
import { extractAttachmentTextIsolated, isAttachmentTextExtractable } from "@kestrel-agents/files";
import { configurePdfCanvasNativeBinding } from "./pdf-runtime-binding";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { canManageOrganization } from "@/lib/knowledge/organization-access";
import { getProjectAccess, requireProjectRole } from "@/lib/projects/access";
import { getThreadForUser } from "@/lib/threads/store";
import { getManagedFileStorageProvider } from "./storage-provider";
import { resolveRunnerAttachmentSource } from "./turn-attachment-resolver";
import {
  ensureEffectiveFileAvailability,
  ensureFileBlobAvailable,
  FileAvailabilityError,
} from "./availability";
import {
  isNativeImageRepresentationMediaType,
  isReusableFileRepresentation,
  modelVisibleMetadataOnlyReason,
  recordFileRepresentationOutcome,
  type FileRepresentationFailureCategory,
} from "./representation";
import {
  isReservedHostedBrowserFileId,
  matchesExpectedUploadMediaType,
  type InternalExpectedUploadMediaType,
} from "./internal-upload-policy";

export type FileScanResult = "clean" | "quarantined" | "unavailable";
export type FileScanner = (input: {
  fileId: string;
  objectKey: string;
  filename: string;
  detectedMediaType: string;
  sizeBytes: number;
  sha256: string;
}) => Promise<FileScanResult>;

export class FileUploadVerificationError extends Error {
  constructor(readonly code:
    | "FILE_SIZE_EXCEEDED"
    | "FILE_SIZE_MISMATCH"
    | "FILE_HASH_MISMATCH"
    | "FILE_MEDIA_TYPE_MISMATCH"
    | "FILE_UPLOAD_ALREADY_USED") {
    super(code);
    this.name = "FileUploadVerificationError";
  }
}

export interface HostedBrowserDownloadFileIdentity {
  operationId: string;
  organizationId: string;
  threadId: string;
  userId: string;
  sessionId: string;
  generation: number;
  pendingDownloadId: string;
  filename: string;
  declaredMediaType: string;
  sizeBytes: number;
  sha256: string;
}

const HOSTED_BROWSER_DOWNLOAD_STAGING_RETENTION_MS = 30 * 60 * 1000;

export async function reserveHostedBrowserDownload(
  input: HostedBrowserDownloadFileIdentity,
): Promise<"reserved" | "in_progress" | "staged" | "promoted"> {
  if (!await getThreadForUser(input.threadId, input.userId, input.organizationId)) {
    throw new Error("Thread not found.");
  }
  validateHostedBrowserDownloadIdentity(input);
  await cleanupExpiredHostedBrowserDownloads();
  const storage = getManagedFileStorageProvider();
  const objectKey = storage.buildOriginalKey({
    organizationId: input.organizationId,
    blobId: hostedBrowserDownloadBlobId(input),
  });
  const existing = await findHostedBrowserDownloadStage(input);
  if (existing) return requireMatchingHostedBrowserDownloadStage(existing, input);
  const now = new Date();
  try {
    await knowledgeDb.insert(schema.browserDownloadStagedObjects).values({
      operationId: input.operationId,
      organizationId: input.organizationId,
      threadId: input.threadId,
      userId: input.userId,
      sessionId: input.sessionId,
      generation: input.generation,
      pendingDownloadId: input.pendingDownloadId,
      sha256: input.sha256,
      effectRevision: hostedBrowserDownloadEffectRevision(input),
      objectKey,
      state: "receiving",
      fileId: null,
      expiresAt: new Date(now.getTime() + HOSTED_BROWSER_DOWNLOAD_STAGING_RETENTION_MS),
      createdAt: now,
      updatedAt: now,
    });
    return "reserved";
  } catch (error) {
    const raced = await findHostedBrowserDownloadStage(input);
    if (!raced) throw error;
    return requireMatchingHostedBrowserDownloadStage(raced, input);
  }
}

export async function stageHostedBrowserDownload(input: HostedBrowserDownloadFileIdentity & {
  body: NodeJS.ReadableStream;
}): Promise<void> {
  if (!await getThreadForUser(input.threadId, input.userId, input.organizationId)) {
    throw new Error("Thread not found.");
  }
  validateHostedBrowserDownloadIdentity(input);
  const storage = getManagedFileStorageProvider();
  const blobId = hostedBrowserDownloadBlobId(input);
  const objectKey = storage.buildOriginalKey({
    organizationId: input.organizationId,
    blobId,
  });
  const stage = await findHostedBrowserDownloadStage(input);
  if (!stage) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
  const stageState = requireMatchingHostedBrowserDownloadStage(stage, input);
  if (stageState === "staged" || stageState === "promoted") return;
  const verifier = new FileVerificationTransform(input.sizeBytes);
  try {
    await storage.putStream({
      key: objectKey,
      body: input.body.pipe(verifier),
      contentType: normalizeMediaType(input.declaredMediaType) ?? "application/octet-stream",
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(input.filename))}`,
    });
    const verified = verifier.result();
    if (verified.sizeBytes !== input.sizeBytes || verified.sha256 !== input.sha256) {
      throw new FileUploadVerificationError("FILE_HASH_MISMATCH");
    }
    const updated = await knowledgeDb.update(schema.browserDownloadStagedObjects)
      .set({ state: "staged", updatedAt: new Date() })
      .where(and(
        eq(schema.browserDownloadStagedObjects.operationId, input.operationId),
        eq(schema.browserDownloadStagedObjects.state, "receiving"),
      )).returning({ operationId: schema.browserDownloadStagedObjects.operationId });
    if (updated.length !== 1) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  } catch (error) {
    await cleanupHostedBrowserDownload(input).catch(() => {});
    throw error;
  }
}

export async function cancelHostedBrowserDownload(
  input: HostedBrowserDownloadFileIdentity,
): Promise<void> {
  validateHostedBrowserDownloadIdentity(input);
  await cleanupHostedBrowserDownload(input);
}

export async function commitHostedBrowserDownload(
  input: HostedBrowserDownloadFileIdentity,
) {
  validateHostedBrowserDownloadIdentity(input);
  const storage = getManagedFileStorageProvider();
  const blobId = hostedBrowserDownloadBlobId(input);
  const fileId = hostedBrowserDownloadFileId(input);
  const objectKey = storage.buildOriginalKey({ organizationId: input.organizationId, blobId });
  if (!await getThreadForUser(input.threadId, input.userId, input.organizationId)) {
    // The staged-object row, not an absence query, owns deletion. Its locked
    // state cannot race a visibility transaction into deleting referenced data.
    await cleanupHostedBrowserDownload(input).catch(() => {});
    throw new Error("Thread not found.");
  }
  const existing = await reconcileHostedBrowserDownloadPromotion(input);
  if (existing) return existing;
  if (!await storage.exists(objectKey)) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
  const createdAt = new Date();
  const mediaType = normalizeMediaType(input.declaredMediaType) ?? "application/octet-stream";
  let canonicalBlob = await knowledgeDb.query.fileBlobs.findFirst({
    where: (table, { and: andOp, eq: eqOp, isNull: isNullOp }) => andOp(
      eqOp(table.organizationId, input.organizationId),
      eqOp(table.sha256, input.sha256),
      isNullOp(table.deletedAt),
    ),
  });
  if (canonicalBlob) {
    await ensureFileBlobAvailable({
      blobId: canonicalBlob.id,
      objectKey: canonicalBlob.objectKey,
      availabilityStatus: canonicalBlob.availabilityStatus,
      deletedAt: canonicalBlob.deletedAt,
    });
  }
  try {
    await knowledgeDb.transaction(async (tx) => {
      const [stage] = await tx.select().from(schema.browserDownloadStagedObjects)
        .where(eq(schema.browserDownloadStagedObjects.operationId, input.operationId))
        .for("update");
      if (!stage || requireMatchingHostedBrowserDownloadStage(stage, input) !== "staged") {
        throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
      }
      if (!canonicalBlob) {
        [canonicalBlob] = await tx.insert(schema.fileBlobs).values({
          id: blobId,
          organizationId: input.organizationId,
          objectKey,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          availabilityStatus: "available",
          availabilityCheckedAt: createdAt,
          scanStatus: "unavailable",
          createdAt,
        }).returning();
      }
      if (!canonicalBlob) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
      await tx.insert(schema.kestrelFiles).values({
        id: fileId,
        organizationId: input.organizationId,
        uploaderUserId: input.userId,
        blobId: canonicalBlob.id,
        filename: sanitizeFilename(input.filename),
        declaredMediaType: mediaType,
        detectedMediaType: mediaType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        lifecycleState: "ready",
        createdAt,
      });
      await tx.insert(schema.fileScopeGrants).values({
        id: `grant-${createHash("sha256").update(`browser-download\0${fileId}`).digest("hex")}`,
        fileId,
        organizationId: input.organizationId,
        scopeType: "thread",
        threadId: input.threadId,
        projectId: null,
        createdByUserId: input.userId,
        createdAt,
      });
      await tx.insert(schema.fileRepresentations).values({
        id: `representation-${createHash("sha256").update(`browser-download\0${fileId}`).digest("hex")}`,
        blobId: canonicalBlob.id,
        kind: "metadata_only",
        status: "pending",
        mediaType,
        error: "Representation processing has not completed.",
        createdAt,
        updatedAt: createdAt,
      }).onConflictDoNothing();
      await tx.insert(schema.browserDownloadPromotions).values({
        operationId: input.operationId,
        organizationId: input.organizationId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        generation: input.generation,
        pendingDownloadId: input.pendingDownloadId,
        sha256: input.sha256,
        effectRevision: hostedBrowserDownloadEffectRevision(input),
        fileId,
        createdAt,
      });
      await tx.update(schema.browserDownloadStagedObjects).set({
        state: canonicalBlob.objectKey === objectKey
          ? "promoted"
          : "cleanup_pending",
        fileId,
        updatedAt: createdAt,
      }).where(eq(schema.browserDownloadStagedObjects.operationId, input.operationId));
    });
  } catch (error) {
    const reconciled = await reconcileHostedBrowserDownloadPromotion(input);
    if (reconciled) return reconciled;
    const racedBlob = await knowledgeDb.query.fileBlobs.findFirst({
      where: (table, { and: andOp, eq: eqOp, isNull: isNullOp }) => andOp(
        eqOp(table.organizationId, input.organizationId),
        eqOp(table.sha256, input.sha256),
        isNullOp(table.deletedAt),
      ),
    });
    if (racedBlob && racedBlob.id !== blobId) {
      return await commitHostedBrowserDownload(input);
    }
    throw error;
  }
  const committedBlob = canonicalBlob;
  if (!committedBlob) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
  const committed = await requireThreadFileForUser({
    fileId,
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (committedBlob.objectKey !== objectKey) {
    await cleanupHostedBrowserDownload(input).catch(() => {});
  }
  return committed;
}

async function cleanupExpiredHostedBrowserDownloads(now = new Date()): Promise<number> {
  const expired = await knowledgeDb.select().from(schema.browserDownloadStagedObjects)
    .where(lt(schema.browserDownloadStagedObjects.expiresAt, now))
    .limit(20);
  for (const row of expired) {
    if (row.state === "promoted" || row.state === "cleaned") continue;
    await cleanupHostedBrowserDownload(row);
  }
  return expired.length;
}

export async function reconcileHostedBrowserDownloadStaging(): Promise<void> {
  while (await cleanupExpiredHostedBrowserDownloads() === 20) {
    // Continue in bounded pages until restart reconciliation owns every expiry.
  }
}

async function cleanupHostedBrowserDownload(
  input: Pick<HostedBrowserDownloadFileIdentity,
    "operationId" | "organizationId" | "threadId" | "userId" | "sessionId" |
    "generation" | "pendingDownloadId" | "sha256"> & Partial<HostedBrowserDownloadFileIdentity>,
): Promise<void> {
  let objectKey: string | undefined;
  await knowledgeDb.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.browserDownloadStagedObjects)
      .where(eq(schema.browserDownloadStagedObjects.operationId, input.operationId))
      .for("update");
    if (!row) return;
    if (
      row.organizationId !== input.organizationId ||
      row.threadId !== input.threadId ||
      row.userId !== input.userId ||
      row.sessionId !== input.sessionId ||
      row.generation !== input.generation ||
      row.pendingDownloadId !== input.pendingDownloadId ||
      row.sha256 !== input.sha256
    ) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
    if (row.state === "promoted" || row.state === "cleaned") return;
    objectKey = row.objectKey;
    await tx.update(schema.browserDownloadStagedObjects).set({
      state: "cleanup_pending",
      updatedAt: new Date(),
    }).where(eq(schema.browserDownloadStagedObjects.operationId, row.operationId));
  });
  if (!objectKey) return;
  await getManagedFileStorageProvider().delete(objectKey);
  await knowledgeDb.update(schema.browserDownloadStagedObjects).set({
    state: "cleaned",
    updatedAt: new Date(),
  }).where(and(
    eq(schema.browserDownloadStagedObjects.operationId, input.operationId),
    eq(schema.browserDownloadStagedObjects.state, "cleanup_pending"),
  ));
}

async function findHostedBrowserDownloadStage(input: HostedBrowserDownloadFileIdentity) {
  return await knowledgeDb.query.browserDownloadStagedObjects.findFirst({
    where: (table, { and: andOp, eq: eqOp, or: orOp }) => orOp(
      eqOp(table.operationId, input.operationId),
      andOp(
        eqOp(table.organizationId, input.organizationId),
        eqOp(table.sessionId, input.sessionId),
        eqOp(table.generation, input.generation),
        eqOp(table.pendingDownloadId, input.pendingDownloadId),
      ),
    ),
  });
}

function requireMatchingHostedBrowserDownloadStage(
  row: typeof schema.browserDownloadStagedObjects.$inferSelect,
  input: HostedBrowserDownloadFileIdentity,
): "in_progress" | "staged" | "promoted" {
  if (
    row.operationId !== input.operationId ||
    row.organizationId !== input.organizationId ||
    row.threadId !== input.threadId ||
    row.userId !== input.userId ||
    row.sessionId !== input.sessionId ||
    row.generation !== input.generation ||
    row.pendingDownloadId !== input.pendingDownloadId ||
    row.sha256 !== input.sha256 ||
    row.effectRevision !== hostedBrowserDownloadEffectRevision(input)
  ) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  if (row.state === "receiving") return "in_progress";
  if (row.state === "staged") return "staged";
  if (row.state === "promoted") return "promoted";
  throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
}

export async function readHostedBrowserDownloadPromotion(input: {
  operationId: string;
  fileId: string;
  organizationId: string;
  threadId: string;
  userId: string;
  sessionId: string;
  generation: number;
}) {
  const result = await knowledgeDb.query.browserDownloadPromotions.findFirst({
    where: (table, { and: andOp, eq: eqOp }) => andOp(
      eqOp(table.operationId, input.operationId),
      eqOp(table.fileId, input.fileId),
      eqOp(table.organizationId, input.organizationId),
      eqOp(table.threadId, input.threadId),
      eqOp(table.sessionId, input.sessionId),
      eqOp(table.generation, input.generation),
    ),
  });
  if (!result) return;
  return await requireThreadFileForUser({
    fileId: result.fileId,
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
}

async function reconcileHostedBrowserDownloadPromotion(
  input: HostedBrowserDownloadFileIdentity,
) {
  const result = await knowledgeDb.query.browserDownloadPromotions.findFirst({
    where: (table, { and: andOp, eq: eqOp }) => andOp(
      eqOp(table.organizationId, input.organizationId),
      eqOp(table.sessionId, input.sessionId),
      eqOp(table.generation, input.generation),
      eqOp(table.pendingDownloadId, input.pendingDownloadId),
    ),
  });
  if (!result) return;
  if (
    result.threadId !== input.threadId ||
    result.sha256 !== input.sha256 ||
    result.effectRevision !== hostedBrowserDownloadEffectRevision(input)
  ) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
  return await requireThreadFileForUser({
    fileId: result.fileId,
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
}

function validateHostedBrowserDownloadIdentity(input: HostedBrowserDownloadFileIdentity): void {
  for (const value of [
    input.operationId,
    input.organizationId,
    input.threadId,
    input.userId,
    input.sessionId,
    input.pendingDownloadId,
    input.filename,
    input.declaredMediaType,
  ]) {
    if (typeof value !== "string" || value.length === 0) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
  validateFileSize(input.sizeBytes);
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw new Error("BROWSER_DOWNLOAD_UNAVAILABLE");
}

function hostedBrowserDownloadBlobId(input: HostedBrowserDownloadFileIdentity): string {
  return `blob-browser-${createHash("sha256").update(JSON.stringify({
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    generation: input.generation,
    pendingDownloadId: input.pendingDownloadId,
    sha256: input.sha256,
  })).digest("hex")}`;
}

function hostedBrowserDownloadFileId(input: HostedBrowserDownloadFileIdentity): string {
  return `file-browser-${createHash("sha256").update(JSON.stringify({
    organizationId: input.organizationId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    generation: input.generation,
    pendingDownloadId: input.pendingDownloadId,
    sha256: input.sha256,
  })).digest("hex")}`;
}

function hostedBrowserDownloadEffectRevision(input: HostedBrowserDownloadFileIdentity): string {
  return createHash("sha256").update(JSON.stringify({
    organizationId: input.organizationId,
    threadId: input.threadId,
    userId: input.userId,
    sessionId: input.sessionId,
    generation: input.generation,
    pendingDownloadId: input.pendingDownloadId,
    filename: sanitizeFilename(input.filename),
    declaredMediaType: normalizeMediaType(input.declaredMediaType) ?? "application/octet-stream",
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
  })).digest("hex");
}

export async function createPublishedFileFromBuffer(input: {
  organizationId: string;
  uploaderUserId: string;
  projectId?: string | null | undefined;
  filename: string;
  declaredMediaType?: string | undefined;
  buffer: Buffer;
}) {
  validateFileSize(input.buffer.byteLength);
  if (input.projectId) {
    await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.uploaderUserId,
      minimumRole: "editor",
    });
  }
  const filename = sanitizeFilename(input.filename);
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const detectedMediaType = detectMediaType(
    input.buffer.subarray(0, 512),
    filename,
    input.declaredMediaType,
  );
  let blob = await knowledgeDb.query.fileBlobs.findFirst({
    where: (table, { and: andOp, eq: eqOp, isNull: isNullOp }) => andOp(
      eqOp(table.organizationId, input.organizationId),
      eqOp(table.sha256, sha256),
      isNullOp(table.deletedAt),
    ),
  });
  const storage = getManagedFileStorageProvider();
  if (blob) {
    blob = await ensureReusableBlob(blob, {
      body: Readable.from(input.buffer),
      contentType: detectedMediaType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
  }
  if (!blob) {
    const blobId = `blob-${randomUUID()}`;
    const objectKey = storage.buildOriginalKey({
      organizationId: input.organizationId,
      blobId,
    });
    await storage.putStream({
      key: objectKey,
      body: Readable.from(input.buffer),
      contentType: detectedMediaType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    try {
      const [createdBlob] = await knowledgeDb.insert(schema.fileBlobs).values({
        id: blobId,
        organizationId: input.organizationId,
        objectKey,
        sizeBytes: input.buffer.byteLength,
        sha256,
        availabilityStatus: "available",
        availabilityCheckedAt: new Date(),
        scanStatus: "unavailable",
      }).returning();
      blob = createdBlob;
    } catch (error) {
      await storage.delete(objectKey).catch(() => {});
      blob = await knowledgeDb.query.fileBlobs.findFirst({
        where: (table, { and: andOp, eq: eqOp, isNull: isNullOp }) => andOp(
          eqOp(table.organizationId, input.organizationId),
          eqOp(table.sha256, sha256),
          isNullOp(table.deletedAt),
        ),
      });
      if (!blob) throw error;
    }
  }
  if (!blob) throw new Error("File blob could not be created.");
  await ensureReusableBlob(blob);
  const fileId = `file-${randomUUID()}`;
  await knowledgeDb.transaction(async (tx) => {
    await tx.insert(schema.kestrelFiles).values({
      id: fileId,
      organizationId: input.organizationId,
      uploaderUserId: input.uploaderUserId,
      blobId: blob.id,
      filename,
      declaredMediaType: normalizeMediaType(input.declaredMediaType),
      detectedMediaType,
      sizeBytes: input.buffer.byteLength,
      sha256,
      lifecycleState: "ready",
    });
    await tx.insert(schema.fileScopeGrants).values({
      id: `grant-${randomUUID()}`,
      fileId,
      organizationId: input.organizationId,
      scopeType: input.projectId ? "project" : "organization",
      threadId: null,
      projectId: input.projectId ?? null,
      createdByUserId: input.uploaderUserId,
    });
  });
  if (await hasReusableRepresentation(blob.id, detectedMediaType) === false) {
    await processStoredFileRepresentation({
      blobId: blob.id,
      objectKey: blob.objectKey,
      filename,
      mediaType: detectedMediaType,
    });
  }
  return await getFileByIdForUser({
    fileId,
    organizationId: input.organizationId,
    userId: input.uploaderUserId,
  });
}

type FileRow = {
  id: string;
  organizationId: string;
  uploaderUserId: string | null;
  blobId: string;
  objectKey: string;
  filename: string;
  declaredMediaType: string | null;
  detectedMediaType: string | null;
  sizeBytes: number;
  sha256: string | null;
  availabilityStatus: "unknown" | "available" | "missing";
  blobDeletedAt: Date | null;
  lifecycleState: "draft" | "ready" | "quarantined" | "failed" | "deleted";
  createdAt: Date;
  representationStatus: "native_image" | "extracted_text" | "staged_file" | "metadata_only";
  metadataOnlyReason: string | null;
  representationText: string | null;
  textTruncated: boolean;
};

const NO_INTERPRETER_REASON =
  "No automatic interpreter is available; the original remains available read-only to tools.";
const FILE_BLOB_DELETION_GRACE_MS = 24 * 60 * 60 * 1000;

export async function initializeThreadFile(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  filename: string;
  sizeBytes: number;
  declaredMediaType?: string | undefined;
  /** Internal deterministic identity; public file APIs never accept this field. */
  trustedFileId?: string | undefined;
}) {
  const thread = await getThreadForUser(input.threadId, input.userId, input.organizationId);
  if (!thread) throw new Error("Thread not found.");
  validateFileSize(input.sizeBytes);
  const filename = sanitizeFilename(input.filename);
  const fileId = input.trustedFileId ?? `file-${randomUUID()}`;
  if (
    input.trustedFileId !== undefined &&
    !/^file-browser-[0-9a-f]{64}$/u.test(fileId)
  ) {
    throw new Error("Trusted file ID is invalid.");
  }
  const blobId = `blob-${randomUUID()}`;
  const storage = getManagedFileStorageProvider();
  const objectKey = storage.buildOriginalKey({ organizationId: input.organizationId, blobId });
  const createdAt = new Date();
  await knowledgeDb.transaction(async (tx) => {
    await tx.insert(schema.fileBlobs).values({
      id: blobId,
      organizationId: input.organizationId,
      objectKey,
      sizeBytes: input.sizeBytes,
      sha256: null,
      availabilityStatus: "unknown",
      scanStatus: "pending",
      createdAt,
    });
    await tx.insert(schema.kestrelFiles).values({
      id: fileId,
      organizationId: input.organizationId,
      uploaderUserId: input.userId,
      blobId,
      filename,
      declaredMediaType: normalizeMediaType(input.declaredMediaType),
      detectedMediaType: null,
      sizeBytes: input.sizeBytes,
      sha256: null,
      lifecycleState: "draft",
      createdAt,
    });
    await tx.insert(schema.fileScopeGrants).values({
      id: `grant-${randomUUID()}`,
      fileId,
      organizationId: input.organizationId,
      scopeType: "thread",
      threadId: input.threadId,
      projectId: null,
      createdByUserId: input.userId,
      createdAt,
    });
    await tx.insert(schema.fileRepresentations).values({
      id: `representation-${randomUUID()}`,
      blobId,
      kind: "metadata_only",
      status: "pending",
      mediaType: normalizeMediaType(input.declaredMediaType) ?? "application/octet-stream",
      error: "Upload has not completed.",
      createdAt,
      updatedAt: createdAt,
    });
  });
  return await requireThreadFileForUser({ ...input, fileId });
}

export async function uploadThreadFile(input: {
  fileId: string;
  threadId: string;
  organizationId: string;
  userId: string;
  body: ReadableStream<Uint8Array> | null;
  contentLength?: number | undefined;
  scanner?: FileScanner | undefined;
  expectedSha256?: string | undefined;
  expectedMediaType?: InternalExpectedUploadMediaType | undefined;
  singleUseDraft?: boolean | undefined;
}) {
  if (!input.body) throw new Error("File body is required.");
  if (
    isReservedHostedBrowserFileId(input.fileId) &&
    input.singleUseDraft !== true
  ) {
    throw new FileUploadVerificationError("FILE_UPLOAD_ALREADY_USED");
  }
  if (
    input.expectedSha256 !== undefined &&
    !/^[0-9a-f]{64}$/u.test(input.expectedSha256)
  ) {
    throw new FileUploadVerificationError("FILE_HASH_MISMATCH");
  }
  const file = await requireThreadFileForUser(input);
  if (input.singleUseDraft === true) {
    if (file.lifecycleState !== "draft") {
      throw new FileUploadVerificationError("FILE_UPLOAD_ALREADY_USED");
    }
    const claimed = await knowledgeDb
      .update(schema.kestrelFiles)
      .set({ lifecycleState: "failed" })
      .where(and(
        eq(schema.kestrelFiles.id, file.id),
        eq(schema.kestrelFiles.lifecycleState, "draft"),
      ))
      .returning({ id: schema.kestrelFiles.id });
    if (claimed.length !== 1) {
      throw new FileUploadVerificationError("FILE_UPLOAD_ALREADY_USED");
    }
  } else if (!["draft", "failed"].includes(file.lifecycleState)) {
    throw new Error("File is not available for upload.");
  }
  if (input.contentLength !== undefined && input.contentLength !== file.sizeBytes) {
    throw new FileUploadVerificationError("FILE_SIZE_MISMATCH");
  }
  const verifier = new FileVerificationTransform(file.sizeBytes);
  const storage = getManagedFileStorageProvider();
  try {
    await storage.putStream({
      key: file.objectKey,
      body: Readable.fromWeb(input.body as unknown as import("node:stream/web").ReadableStream).pipe(verifier),
      contentType: normalizeMediaType(file.declaredMediaType) ?? "application/octet-stream",
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    });
    const verified = verifier.result();
    if (
      input.expectedMediaType !== undefined &&
      !matchesExpectedUploadMediaType(verifier.header, input.expectedMediaType)
    ) {
      throw new FileUploadVerificationError("FILE_MEDIA_TYPE_MISMATCH");
    }
    if (
      input.expectedSha256 !== undefined &&
      verified.sha256 !== input.expectedSha256
    ) {
      throw new FileUploadVerificationError("FILE_HASH_MISMATCH");
    }
    const detectedMediaType = detectMediaType(verifier.header, file.filename, file.declaredMediaType ?? undefined);
    const scanResult = await input.scanner?.({
      fileId: file.id,
      objectKey: file.objectKey,
      filename: file.filename,
      detectedMediaType,
      sizeBytes: verified.sizeBytes,
      sha256: verified.sha256,
    }) ?? "unavailable";
    const canonicalBlob = await finalizeBlobDeduplication({
      file,
      sha256: verified.sha256,
      scanResult,
      detectedMediaType,
    });
    const quarantined = scanResult === "quarantined" || canonicalBlob.scanStatus === "quarantined";
    await knowledgeDb.update(schema.kestrelFiles).set({
      blobId: canonicalBlob.id,
      detectedMediaType,
      sha256: verified.sha256,
      lifecycleState: quarantined ? "quarantined" : "ready",
    }).where(eq(schema.kestrelFiles.id, file.id));
    if (
      quarantined === false
      && (
        canonicalBlob.id === file.blobId
        || await hasReusableRepresentation(canonicalBlob.id, detectedMediaType) === false
      )
    ) {
      await processBlobRepresentation({
        blobId: canonicalBlob.id,
        objectKey: canonicalBlob.objectKey,
        filename: file.filename,
        mediaType: detectedMediaType,
      });
    }
    return await requireThreadFileForUser(input);
  } catch (error) {
    await storage.delete(file.objectKey).catch(() => {});
    await knowledgeDb.update(schema.kestrelFiles).set({ lifecycleState: "failed" })
      .where(eq(schema.kestrelFiles.id, file.id));
    await knowledgeDb.update(schema.fileRepresentations).set({
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 500) : "Upload failed.",
      updatedAt: new Date(),
    }).where(eq(schema.fileRepresentations.blobId, file.blobId));
    throw error;
  }
}

export async function getThreadFileForUser(input: {
  fileId: string;
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  return await requireThreadFileForUser(input);
}

export async function getFileByIdForUser(input: {
  fileId: string;
  organizationId: string;
  userId: string;
}) {
  const rows = await selectFileRows([eq(schema.kestrelFiles.id, input.fileId), eq(schema.kestrelFiles.organizationId, input.organizationId)]);
  const file = rows[0];
  if (!file || file.lifecycleState === "deleted") throw new Error("File not found.");
  const grants = await knowledgeDb.select().from(schema.fileScopeGrants).where(and(
    eq(schema.fileScopeGrants.fileId, file.id),
    isNull(schema.fileScopeGrants.revokedAt),
  ));
  for (const grant of grants) {
    if (grant.scopeType === "organization") return file;
    if (grant.scopeType === "thread" && grant.threadId) {
      const thread = await getThreadForUser(grant.threadId, input.userId, input.organizationId);
      if (thread) return file;
    }
    if (grant.scopeType === "project" && grant.projectId) {
      const access = await getProjectAccess({
        projectId: grant.projectId,
        organizationId: input.organizationId,
        userId: input.userId,
      });
      if (access) return file;
    }
  }
  throw new Error("File not found.");
}

export async function getFileMetadataForUser(input: {
  fileId: string;
  organizationId: string;
  userId: string;
}) {
  const file = await getFileByIdForUser(input);
  const scopes = await knowledgeDb.select({
    scope: schema.fileScopeGrants.scopeType,
    threadId: schema.fileScopeGrants.threadId,
    projectId: schema.fileScopeGrants.projectId,
    createdAt: schema.fileScopeGrants.createdAt,
  }).from(schema.fileScopeGrants).where(and(
    eq(schema.fileScopeGrants.fileId, file.id),
    isNull(schema.fileScopeGrants.revokedAt),
  ));
  return { ...file, scopes };
}

export async function getVisibleFileForThread(input: {
  fileId: string;
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const thread = await getThreadForUser(input.threadId, input.userId, input.organizationId);
  if (!thread) throw new Error("Thread not found.");
  const rows = await selectFileRows([
    eq(schema.kestrelFiles.id, input.fileId),
    eq(schema.kestrelFiles.organizationId, input.organizationId),
    sql`exists (
      select 1 from ${schema.fileScopeGrants} visible_grant
      where visible_grant.file_id = ${schema.kestrelFiles.id}
        and visible_grant.revoked_at is null
        and (
          (visible_grant.scope_type = 'thread' and visible_grant.thread_id = ${input.threadId})
          or (visible_grant.scope_type = 'organization' and visible_grant.organization_id = ${input.organizationId})
          or (visible_grant.scope_type = 'project' and visible_grant.project_id = ${thread.projectId ?? ""})
        )
    )`,
  ]);
  const file = rows[0];
  if (!file || file.lifecycleState === "deleted") throw new Error("File not found.");
  return file;
}

/**
 * Produces the single model-visible file representation used by both ordinary
 * file open calls and receipt-scoped attachment import.  The file remains
 * Thread-scoped; callers never receive the storage key.
 */
export async function openVisibleFileForThread(input: {
  fileId: string;
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const file = await getVisibleFileForThread(input);
  if (file.lifecycleState !== "ready") throw new Error("File is unavailable.");
  await ensureEffectiveFileAvailability({
    fileId: file.id,
    lifecycleState: file.lifecycleState,
    blobId: file.blobId,
    objectKey: file.objectKey,
    availabilityStatus: file.availabilityStatus,
    blobDeletedAt: file.blobDeletedAt,
  });
  const storage = getManagedFileStorageProvider();
  const sourceUrl = storage.signedReadUrl
    ? await storage.signedReadUrl(file.objectKey, 900)
    : undefined;
  const metadataOnlyReason = modelVisibleMetadataOnlyReason(
    file.representationStatus,
    file.metadataOnlyReason,
  );
  return {
    fileId: file.id,
    filename: file.filename,
    mediaType:
      file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    representation: file.representationStatus,
    ...(file.representationText
      ? { text: file.representationText, truncated: file.textTruncated }
      : {}),
    ...(metadataOnlyReason ? { metadataOnlyReason } : {}),
    ...(sourceUrl ? { sourceUrl, sourceUrlExpiresInSeconds: 900 } : {}),
  };
}

export async function deleteDraftThreadFile(input: {
  fileId: string;
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const file = await requireThreadFileForUser(input);
  const linked = await knowledgeDb.select({ fileId: schema.threadMessageFiles.fileId })
    .from(schema.threadMessageFiles).where(eq(schema.threadMessageFiles.fileId, file.id)).limit(1);
  if (linked.length > 0) throw new Error("Submitted files cannot be removed.");
  const [deleted] = await knowledgeDb.delete(schema.kestrelFiles).where(eq(schema.kestrelFiles.id, file.id)).returning();
  if (!deleted) return false;
  await scheduleBlobDeletionIfUnreferenced(file.blobId);
  return true;
}

export async function discardUnreferencedFile(
  fileId: string,
  options: { removeScopeGrants?: boolean } = {},
): Promise<boolean> {
  const file = await knowledgeDb.select({
    id: schema.kestrelFiles.id,
    blobId: schema.kestrelFiles.blobId,
    objectKey: schema.fileBlobs.objectKey,
  }).from(schema.kestrelFiles)
    .innerJoin(schema.fileBlobs, eq(schema.fileBlobs.id, schema.kestrelFiles.blobId))
    .where(and(
      eq(schema.kestrelFiles.id, fileId),
      sql`not exists (select 1 from ${schema.threadMessageFiles} where ${schema.threadMessageFiles.fileId} = ${schema.kestrelFiles.id})`,
      sql`not exists (select 1 from ${schema.knowledgeDocuments} where ${schema.knowledgeDocuments.fileId} = ${schema.kestrelFiles.id})`,
      options.removeScopeGrants
        ? undefined
        : sql`not exists (select 1 from ${schema.fileScopeGrants} where ${schema.fileScopeGrants.fileId} = ${schema.kestrelFiles.id} and ${schema.fileScopeGrants.revokedAt} is null)`,
    )).limit(1);
  if (!file[0]) return false;
  if (options.removeScopeGrants) {
    await knowledgeDb.delete(schema.fileScopeGrants).where(eq(schema.fileScopeGrants.fileId, fileId));
  }
  await knowledgeDb.delete(schema.kestrelFiles).where(eq(schema.kestrelFiles.id, fileId));
  await scheduleBlobDeletionIfUnreferenced(file[0].blobId);
  return true;
}

export async function revokeFileScopeForManagement(input: {
  fileId: string;
  organizationId: string;
  scope: "project" | "organization";
  projectId?: string | null | undefined;
}): Promise<void> {
  await knowledgeDb.update(schema.fileScopeGrants).set({ revokedAt: new Date() }).where(and(
    eq(schema.fileScopeGrants.fileId, input.fileId),
    eq(schema.fileScopeGrants.organizationId, input.organizationId),
    eq(schema.fileScopeGrants.scopeType, input.scope),
    input.scope === "project"
      ? eq(schema.fileScopeGrants.projectId, input.projectId ?? "")
      : isNull(schema.fileScopeGrants.projectId),
    isNull(schema.fileScopeGrants.revokedAt),
  ));
}

export async function resolveReadyThreadFiles(input: {
  fileIds: string[];
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  validateSelection(input.fileIds);
  if (input.fileIds.length === 0) return [];
  const thread = await getThreadForUser(input.threadId, input.userId, input.organizationId);
  if (!thread) throw new Error("Thread not found.");
  const grants = await knowledgeDb.select({ fileId: schema.fileScopeGrants.fileId }).from(schema.fileScopeGrants).where(and(
    eq(schema.fileScopeGrants.organizationId, input.organizationId),
    eq(schema.fileScopeGrants.scopeType, "thread"),
    eq(schema.fileScopeGrants.threadId, input.threadId),
    isNull(schema.fileScopeGrants.revokedAt),
    inArray(schema.fileScopeGrants.fileId, input.fileIds),
  ));
  const granted = new Set(grants.map((grant) => grant.fileId));
  const rows = await selectFileRows([
    eq(schema.kestrelFiles.organizationId, input.organizationId),
    inArray(schema.kestrelFiles.id, input.fileIds),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = input.fileIds.map((id) => granted.has(id) ? byId.get(id) : undefined);
  if (ordered.some((row) => !row || row.lifecycleState !== "ready" || !row.sha256 || !row.detectedMediaType)) {
    throw new Error("One or more files are unavailable, incomplete, or quarantined.");
  }
  const readyFiles = ordered as Array<FileRow & { sha256: string; detectedMediaType: string }>;
  await Promise.all(readyFiles.map((file) => ensureEffectiveFileAvailability({
    fileId: file.id,
    lifecycleState: file.lifecycleState,
    blobId: file.blobId,
    objectKey: file.objectKey,
    availabilityStatus: file.availabilityStatus,
    blobDeletedAt: file.blobDeletedAt,
  })));
  if (ordered.reduce((sum, row) => sum + (row?.sizeBytes ?? 0), 0) > CONVERSATION_ATTACHMENT_MAX_TURN_BYTES) {
    throw new Error("Files exceed the 500 MiB per-message limit.");
  }
  return readyFiles;
}

export async function resolveThreadFilesForExecution(input: {
  fileIds: string[];
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<RunnerTurnAttachment[]> {
  const files = await resolveReadyThreadFiles(input);
  const storage = getManagedFileStorageProvider();
  return await Promise.all(files.map(async (file) => {
    const metadataOnlyReason = modelVisibleMetadataOnlyReason(
      file.representationStatus,
      file.metadataOnlyReason,
    );
    const kind = file.representationStatus === "native_image"
      ? "image" as const
      : file.representationStatus === "extracted_text" ? "text" as const : "file" as const;
    const resolvedSource = await resolveRunnerAttachmentSource(storage, file.objectKey, 900);
    const source = resolvedSource.sourceUrl
      ? {
          sourceUrl: resolvedSource.sourceUrl,
          sourceUrlExpiresAt: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
        }
      : { data: resolvedSource.data };
    return {
      fileId: file.id,
      attachmentId: file.id,
      threadId: input.threadId,
      filename: file.filename,
      mimeType: file.detectedMediaType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      kind,
      representationStatus: file.representationStatus,
      createdAt: file.createdAt.toISOString(),
      ...source,
      ...(file.representationText ? { text: file.representationText } : {}),
      ...(file.textTruncated ? { textTruncated: true } : {}),
      ...(metadataOnlyReason ? { metadataOnlyReason } : {}),
    } satisfies RunnerTurnAttachment;
  }));
}

export async function linkFilesToMessage(input: {
  fileIds: string[];
  messageId: string;
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<ConversationFileReference[]> {
  const files = await resolveReadyThreadFiles(input);
  if (files.length > 0) {
    await knowledgeDb.insert(schema.threadMessageFiles).values(files.map((file, ordinal) => ({
      messageId: input.messageId,
      fileId: file.id,
      ordinal,
    }))).onConflictDoNothing();
  }
  return files.map(toFileReference);
}

export async function publishFileScope(input: {
  fileId: string;
  organizationId: string;
  userId: string;
  scope: "project" | "organization";
  projectId?: string | undefined;
}) {
  const file = await getFileByIdForUser(input);
  const canManage = await canManageOrganization({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (file.uploaderUserId !== input.userId && !canManage) {
    throw new Error("Only the uploader or an organization administrator can publish this file.");
  }
  if (input.scope === "project") {
    if (!input.projectId) throw new Error("Project scope requires a project ID.");
    await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      minimumRole: "editor",
    });
  } else if (!canManage) {
    throw new Error("Organization administrator access is required to publish organization files.");
  }
  const scopePredicate = and(
    eq(schema.fileScopeGrants.fileId, file.id),
    eq(schema.fileScopeGrants.organizationId, input.organizationId),
    eq(schema.fileScopeGrants.scopeType, input.scope),
    input.scope === "project"
      ? eq(schema.fileScopeGrants.projectId, input.projectId as string)
      : isNull(schema.fileScopeGrants.projectId),
    isNull(schema.fileScopeGrants.revokedAt),
  );
  const existing = await knowledgeDb.select().from(schema.fileScopeGrants)
    .where(scopePredicate).limit(1);
  if (existing[0]) return existing[0];
  const [grant] = await knowledgeDb.insert(schema.fileScopeGrants).values({
    id: `grant-${randomUUID()}`,
    fileId: file.id,
    organizationId: input.organizationId,
    scopeType: input.scope,
    threadId: null,
    projectId: input.scope === "project" ? input.projectId ?? null : null,
    createdByUserId: input.userId,
  }).onConflictDoNothing().returning();
  if (grant) return grant;
  const concurrent = await knowledgeDb.select().from(schema.fileScopeGrants)
    .where(scopePredicate).limit(1);
  if (concurrent[0]) return concurrent[0];
  throw new Error("File scope grant could not be created or reused.");
}

export async function revokeFileScope(input: {
  fileId: string;
  organizationId: string;
  userId: string;
  scope: "project" | "organization";
  projectId?: string | undefined;
}): Promise<boolean> {
  const file = await getFileByIdForUser(input);
  const canManage = await canManageOrganization({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (file.uploaderUserId !== input.userId && !canManage) {
    throw new Error("Only the uploader or an organization administrator can revoke this file scope.");
  }
  if (input.scope === "project") {
    if (!input.projectId) throw new Error("Project scope requires a project ID.");
    await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      minimumRole: "editor",
    });
  } else if (!canManage) {
    throw new Error("Organization administrator access is required to revoke organization files.");
  }
  const revoked = await knowledgeDb.update(schema.fileScopeGrants).set({ revokedAt: new Date() }).where(and(
    eq(schema.fileScopeGrants.fileId, file.id),
    eq(schema.fileScopeGrants.scopeType, input.scope),
    input.scope === "project"
      ? eq(schema.fileScopeGrants.projectId, input.projectId as string)
      : isNull(schema.fileScopeGrants.projectId),
    isNull(schema.fileScopeGrants.revokedAt),
  )).returning({ id: schema.fileScopeGrants.id });
  return revoked.length > 0;
}

export async function listThreadFileInventory(input: {
  threadId: string;
  organizationId: string;
  userId: string;
  limit?: number | undefined;
  checkAvailability?: boolean | undefined;
}) {
  const thread = await getThreadForUser(input.threadId, input.userId, input.organizationId);
  if (!thread) throw new Error("Thread not found.");
  const rows = await knowledgeDb.select({
    fileId: schema.kestrelFiles.id,
    blobId: schema.kestrelFiles.blobId,
    objectKey: schema.fileBlobs.objectKey,
    filename: schema.kestrelFiles.filename,
    mediaType: schema.kestrelFiles.detectedMediaType,
    sizeBytes: schema.kestrelFiles.sizeBytes,
    sha256: schema.kestrelFiles.sha256,
    state: schema.kestrelFiles.lifecycleState,
    availabilityStatus: schema.fileBlobs.availabilityStatus,
    blobDeletedAt: schema.fileBlobs.deletedAt,
    createdAt: schema.kestrelFiles.createdAt,
  }).from(schema.fileScopeGrants)
    .innerJoin(schema.kestrelFiles, eq(schema.kestrelFiles.id, schema.fileScopeGrants.fileId))
    .innerJoin(schema.fileBlobs, eq(schema.fileBlobs.id, schema.kestrelFiles.blobId))
    .where(and(
      eq(schema.fileScopeGrants.organizationId, input.organizationId),
      eq(schema.fileScopeGrants.scopeType, "thread"),
      eq(schema.fileScopeGrants.threadId, input.threadId),
      isNull(schema.fileScopeGrants.revokedAt),
      eq(schema.kestrelFiles.lifecycleState, "ready"),
      input.checkAvailability === false
        ? eq(schema.fileBlobs.availabilityStatus, "available")
        : undefined,
    ))
    .orderBy(desc(schema.kestrelFiles.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 100));
  if (input.checkAvailability !== false) {
    await Promise.all(rows.map((row) => ensureEffectiveFileAvailability({
      fileId: row.fileId,
      lifecycleState: row.state,
      blobId: row.blobId,
      objectKey: row.objectKey,
      availabilityStatus: row.availabilityStatus,
      blobDeletedAt: row.blobDeletedAt,
    })));
  }
  return rows;
}

export async function searchVisibleFiles(input: {
  organizationId: string;
  userId: string;
  threadId: string;
  projectId?: string | null | undefined;
  query: string;
  includeThread?: boolean | undefined;
  limit?: number | undefined;
}) {
  const thread = await getThreadForUser(input.threadId, input.userId, input.organizationId);
  if (!thread) throw new Error("Thread not found.");
  if (input.projectId && input.projectId !== thread.projectId) {
    throw new Error("Project file scope does not belong to this Thread.");
  }
  const query = input.query.trim();
  if (!query) throw new Error("File search query is required.");
  const likeQuery = `%${escapeLike(query)}%`;
  const legacyKnowledgeText = sql<string | null>`(
    select chunk.content
    from ${schema.knowledgeDocumentChunks} chunk
    inner join ${schema.knowledgeDocuments} document
      on document.id = chunk.document_id
    where document.file_id = ${schema.kestrelFiles.id}
      and chunk.content ilike ${likeQuery}
    order by chunk.chunk_index asc
    limit 1
  )`;
  const scope = or(
    ...(input.includeThread === false ? [] : [and(
      eq(schema.fileScopeGrants.scopeType, "thread"),
      eq(schema.fileScopeGrants.threadId, input.threadId),
    )]),
    ...(thread.projectId ? [and(
      eq(schema.fileScopeGrants.scopeType, "project"),
      eq(schema.fileScopeGrants.projectId, thread.projectId),
    )] : []),
    eq(schema.fileScopeGrants.scopeType, "organization"),
  );
  return await knowledgeDb.selectDistinct({
    fileId: schema.kestrelFiles.id,
    filename: schema.kestrelFiles.filename,
    mediaType: schema.kestrelFiles.detectedMediaType,
    sizeBytes: schema.kestrelFiles.sizeBytes,
    sha256: schema.kestrelFiles.sha256,
    representation: schema.fileRepresentations.kind,
    text: sql<string | null>`coalesce(${schema.fileRepresentations.textContent}, ${legacyKnowledgeText})`,
  }).from(schema.fileScopeGrants)
    .innerJoin(schema.kestrelFiles, eq(schema.kestrelFiles.id, schema.fileScopeGrants.fileId))
    .leftJoin(schema.fileRepresentations, and(
      eq(schema.fileRepresentations.blobId, schema.kestrelFiles.blobId),
      eq(schema.fileRepresentations.status, "ready"),
    ))
    .where(and(
      eq(schema.fileScopeGrants.organizationId, input.organizationId),
      isNull(schema.fileScopeGrants.revokedAt),
      scope,
      eq(schema.kestrelFiles.lifecycleState, "ready"),
      or(
        ilike(schema.kestrelFiles.filename, likeQuery),
        ilike(schema.fileRepresentations.textContent, likeQuery),
        sql`exists (
          select 1
          from ${schema.knowledgeDocuments} document
          inner join ${schema.knowledgeDocumentChunks} chunk
            on chunk.document_id = document.id
          where document.file_id = ${schema.kestrelFiles.id}
            and chunk.content ilike ${likeQuery}
        )`,
      ),
    ))
    .limit(Math.min(Math.max(input.limit ?? 10, 1), 25));
}

export async function cleanupExpiredFiles(now = new Date()): Promise<number> {
  await cleanupPendingBlobDeletions(now);
  const cutoff = new Date(now.getTime() - CONVERSATION_ATTACHMENT_DRAFT_RETENTION_MS);
  const candidates = await knowledgeDb.select({
    id: schema.kestrelFiles.id,
    blobId: schema.kestrelFiles.blobId,
    objectKey: schema.fileBlobs.objectKey,
  }).from(schema.kestrelFiles)
    .innerJoin(schema.fileBlobs, eq(schema.fileBlobs.id, schema.kestrelFiles.blobId))
    .where(and(
      inArray(schema.kestrelFiles.lifecycleState, ["draft", "ready", "failed"]),
      lt(schema.kestrelFiles.createdAt, cutoff),
      sql`not exists (select 1 from ${schema.threadMessageFiles} where ${schema.threadMessageFiles.fileId} = ${schema.kestrelFiles.id})`,
      sql`not exists (select 1 from ${schema.fileScopeGrants} where ${schema.fileScopeGrants.fileId} = ${schema.kestrelFiles.id} and ${schema.fileScopeGrants.scopeType} <> 'thread' and ${schema.fileScopeGrants.revokedAt} is null)`,
    ));
  for (const candidate of candidates) {
    await knowledgeDb.delete(schema.kestrelFiles).where(eq(schema.kestrelFiles.id, candidate.id));
    await scheduleBlobDeletionIfUnreferenced(candidate.blobId);
  }
  await knowledgeDb.delete(schema.threads).where(and(
    lt(schema.threads.createdAt, cutoff),
    isNull(schema.threads.activeStreamId),
    sql`not exists (select 1 from ${schema.threadMessages} where ${schema.threadMessages.threadId} = ${schema.threads.id})`,
    sql`not exists (select 1 from ${schema.fileScopeGrants} where ${schema.fileScopeGrants.threadId} = ${schema.threads.id})`,
  ));
  return candidates.length;
}

export function toCompatibilityReference(file: FileRow): ConversationAttachmentReference {
  return {
    type: "kestrel-attachment",
    attachmentId: file.id,
    fileId: file.id,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    mediaType: file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
    representationKind: file.representationStatus,
    status: file.lifecycleState,
  };
}

async function requireThreadFileForUser(input: {
  fileId: string;
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const thread = await getThreadForUser(input.threadId, input.userId, input.organizationId);
  if (!thread) throw new Error("Thread not found.");
  const rows = await selectFileRows([
    eq(schema.kestrelFiles.id, input.fileId),
    eq(schema.kestrelFiles.organizationId, input.organizationId),
    sql`exists (select 1 from ${schema.fileScopeGrants} grant_row where grant_row.file_id = ${schema.kestrelFiles.id} and grant_row.scope_type = 'thread' and grant_row.thread_id = ${input.threadId} and grant_row.revoked_at is null)`,
  ]);
  const file = rows[0];
  if (!file || file.lifecycleState === "deleted") throw new Error("File not found.");
  return file;
}

async function selectFileRows(conditions: Array<SQL | undefined>) {
  return await knowledgeDb.select({
    id: schema.kestrelFiles.id,
    organizationId: schema.kestrelFiles.organizationId,
    uploaderUserId: schema.kestrelFiles.uploaderUserId,
    blobId: schema.kestrelFiles.blobId,
    objectKey: schema.fileBlobs.objectKey,
    filename: schema.kestrelFiles.filename,
    declaredMediaType: schema.kestrelFiles.declaredMediaType,
    detectedMediaType: schema.kestrelFiles.detectedMediaType,
    sizeBytes: schema.kestrelFiles.sizeBytes,
    sha256: schema.kestrelFiles.sha256,
    lifecycleState: schema.kestrelFiles.lifecycleState,
    availabilityStatus: schema.fileBlobs.availabilityStatus,
    blobDeletedAt: schema.fileBlobs.deletedAt,
    createdAt: schema.kestrelFiles.createdAt,
    representationStatus: sql<FileRow["representationStatus"]>`coalesce(${schema.fileRepresentations.kind}, 'metadata_only')`,
    metadataOnlyReason: schema.fileRepresentations.error,
    representationText: schema.fileRepresentations.textContent,
    textTruncated: sql<boolean>`coalesce(${schema.fileRepresentations.truncated}, false)`,
  }).from(schema.kestrelFiles)
    .innerJoin(schema.fileBlobs, eq(schema.fileBlobs.id, schema.kestrelFiles.blobId))
    .leftJoin(schema.fileRepresentations, and(
      eq(schema.fileRepresentations.blobId, schema.kestrelFiles.blobId),
      or(
        eq(schema.fileRepresentations.kind, "native_image"),
        eq(schema.fileRepresentations.kind, "extracted_text"),
        eq(schema.fileRepresentations.kind, "metadata_only"),
      ),
    ))
    .where(and(...conditions)) as FileRow[];
}

async function finalizeBlobDeduplication(input: {
  file: FileRow;
  sha256: string;
  scanResult: FileScanResult;
  detectedMediaType: string;
}) {
  const existing = await knowledgeDb.query.fileBlobs.findFirst({
    where: (table, { and: andOp, eq: eqOp, isNull: isNullOp }) => andOp(
      eqOp(table.organizationId, input.file.organizationId),
      eqOp(table.sha256, input.sha256),
      isNullOp(table.deletedAt),
    ),
  });
  if (existing && existing.id !== input.file.blobId) {
    const source = await getManagedFileStorageProvider().readStream(input.file.objectKey);
    const restored = await ensureReusableBlob(existing, {
      body: Readable.from(source),
      contentType: input.detectedMediaType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.file.filename)}`,
    });
    await knowledgeDb.update(schema.kestrelFiles).set({ blobId: existing.id })
      .where(eq(schema.kestrelFiles.id, input.file.id));
    await knowledgeDb.delete(schema.fileBlobs).where(eq(schema.fileBlobs.id, input.file.blobId));
    await getManagedFileStorageProvider().delete(input.file.objectKey).catch(() => {});
    return restored;
  }
  let updated: typeof schema.fileBlobs.$inferSelect | undefined;
  try {
    [updated] = await knowledgeDb.update(schema.fileBlobs).set({
      sha256: input.sha256,
      scanStatus: input.scanResult,
      availabilityStatus: "available",
      availabilityCheckedAt: new Date(),
    }).where(eq(schema.fileBlobs.id, input.file.blobId)).returning();
  } catch (error) {
    const raced = await knowledgeDb.query.fileBlobs.findFirst({
      where: (table, { and: andOp, eq: eqOp, isNull: isNullOp }) => andOp(
        eqOp(table.organizationId, input.file.organizationId),
        eqOp(table.sha256, input.sha256),
        isNullOp(table.deletedAt),
      ),
    });
    if (!raced || raced.id === input.file.blobId) throw error;
    const source = await getManagedFileStorageProvider().readStream(input.file.objectKey);
    const restored = await ensureReusableBlob(raced, {
      body: Readable.from(source),
      contentType: input.detectedMediaType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.file.filename)}`,
    });
    await knowledgeDb.update(schema.kestrelFiles).set({ blobId: raced.id })
      .where(eq(schema.kestrelFiles.id, input.file.id));
    await knowledgeDb.delete(schema.fileBlobs).where(eq(schema.fileBlobs.id, input.file.blobId));
    await getManagedFileStorageProvider().delete(input.file.objectKey).catch(() => {});
    return restored;
  }
  if (!updated) throw new Error("File blob could not be finalized.");
  return updated;
}

async function ensureReusableBlob(
  blob: typeof schema.fileBlobs.$inferSelect,
  restoration?: {
    body: Readable;
    contentType: string;
    contentDisposition?: string | undefined;
  },
) {
  let current = blob;
  if (current.availabilityStatus === "unknown" && restoration) {
    try {
      await ensureFileBlobAvailable({
        blobId: current.id,
        objectKey: current.objectKey,
        availabilityStatus: current.availabilityStatus,
        deletedAt: current.deletedAt,
      });
    } catch (error) {
      if (!(error instanceof FileAvailabilityError) || error.code !== "ATTACHMENT_BLOB_MISSING") {
        throw error;
      }
    }
    const classified = await knowledgeDb.query.fileBlobs.findFirst({
      where: eq(schema.fileBlobs.id, current.id),
    });
    if (!classified) throw new Error("File blob not found.");
    current = classified;
    if (current.availabilityStatus === "available" && !current.deletedAt) {
      return current;
    }
  }
  if (current.availabilityStatus === "missing" && restoration) {
    const storage = getManagedFileStorageProvider();
    await storage.putStream({
      key: current.objectKey,
      body: restoration.body,
      contentType: restoration.contentType,
      ...(restoration.contentDisposition
        ? { contentDisposition: restoration.contentDisposition }
        : {}),
    });
    const [restored] = await knowledgeDb.update(schema.fileBlobs).set({
      availabilityStatus: "available",
      availabilityCheckedAt: new Date(),
      deletedAt: null,
    }).where(and(
      eq(schema.fileBlobs.id, current.id),
      eq(schema.fileBlobs.sha256, current.sha256 ?? ""),
      eq(schema.fileBlobs.availabilityStatus, "missing"),
      isNull(schema.fileBlobs.deletedAt),
    )).returning();
    if (restored) return restored;
    const committed = await knowledgeDb.query.fileBlobs.findFirst({
      where: eq(schema.fileBlobs.id, current.id),
    });
    if (committed?.availabilityStatus === "available" && !committed.deletedAt) {
      return committed;
    }
  }
  await ensureFileBlobAvailable({
    blobId: current.id,
    objectKey: current.objectKey,
    availabilityStatus: current.availabilityStatus,
    deletedAt: current.deletedAt,
  });
  return current;
}

export async function processStoredFileRepresentation(input: {
  blobId: string;
  objectKey: string;
  filename: string;
  mediaType: string;
}) {
  const startedAt = Date.now();
  const storage = getManagedFileStorageProvider();
  const blob = await knowledgeDb.query.fileBlobs.findFirst({
    where: eq(schema.fileBlobs.id, input.blobId),
  });
  if (!blob) throw new Error("File blob not found.");
  await ensureFileBlobAvailable({
    blobId: blob.id,
    objectKey: input.objectKey,
    availabilityStatus: blob.availabilityStatus,
    deletedAt: blob.deletedAt,
  });
  let kind: "native_image" | "extracted_text" | "metadata_only" = "metadata_only";
  let textContent: string | null = null;
  let truncated = false;
  let error: string | null = NO_INTERPRETER_REASON;
  let failureCategory: FileRepresentationFailureCategory | undefined = "unsupported_media_type";
  if (isNativeImageRepresentationMediaType(input.mediaType)) {
    kind = "native_image";
    error = null;
    failureCategory = undefined;
  } else if (isAttachmentTextExtractable(input.mediaType)) {
    try {
      configurePdfCanvasNativeBinding();
      const extraction = await extractAttachmentTextIsolated({
        buffer: await storage.readBuffer(input.objectKey),
        filename: input.filename,
        mediaType: input.mediaType,
        timeoutMs: 30_000,
      });
      if (extraction.text) {
        kind = "extracted_text";
        textContent = extraction.text;
        truncated = extraction.truncated;
        error = null;
        failureCategory = undefined;
      } else {
        error = "Attachment extractor returned no text.";
        failureCategory = "empty_extraction";
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 500) : "File processing failed.";
      failureCategory = "extraction_failed";
    }
  }
  await knowledgeDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:file-representation:${input.blobId}`}, 0))`);
    await tx.delete(schema.fileRepresentations)
      .where(eq(schema.fileRepresentations.blobId, input.blobId));
    await tx.insert(schema.fileRepresentations).values({
      id: `representation-${randomUUID()}`,
      blobId: input.blobId,
      kind,
      status: failureCategory === "extraction_failed" || failureCategory === "empty_extraction"
        ? "failed"
        : "ready",
      mediaType: input.mediaType,
      textContent,
      truncated,
      error,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  recordFileRepresentationOutcome({
    outcome: kind,
    mediaType: input.mediaType,
    durationMs: Date.now() - startedAt,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
  });
}

const processBlobRepresentation = processStoredFileRepresentation;

async function hasReusableRepresentation(blobId: string, mediaType: string): Promise<boolean> {
  const row = await knowledgeDb.query.fileRepresentations.findFirst({
    where: (table, { eq: eqOp }) => eqOp(table.blobId, blobId),
  });
  return row !== undefined && isReusableFileRepresentation({
    kind: row.kind,
    status: row.status,
    mediaType,
  });
}

async function scheduleBlobDeletionIfUnreferenced(blobId: string): Promise<void> {
  const reference = await knowledgeDb.select({ id: schema.kestrelFiles.id }).from(schema.kestrelFiles)
    .where(eq(schema.kestrelFiles.blobId, blobId)).limit(1);
  if (reference.length > 0) return;
  await knowledgeDb.update(schema.fileBlobs).set({ deletedAt: new Date() })
    .where(and(eq(schema.fileBlobs.id, blobId), isNull(schema.fileBlobs.deletedAt)));
}

async function cleanupPendingBlobDeletions(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - FILE_BLOB_DELETION_GRACE_MS);
  const candidates = await knowledgeDb.select({
    id: schema.fileBlobs.id,
    objectKey: schema.fileBlobs.objectKey,
  }).from(schema.fileBlobs).where(and(
    lt(schema.fileBlobs.deletedAt, cutoff),
    sql`not exists (select 1 from ${schema.kestrelFiles} where ${schema.kestrelFiles.blobId} = ${schema.fileBlobs.id})`,
  ));
  const storage = getManagedFileStorageProvider();
  for (const candidate of candidates) {
    await storage.delete(candidate.objectKey);
    await knowledgeDb.delete(schema.fileBlobs).where(and(
      eq(schema.fileBlobs.id, candidate.id),
      sql`not exists (select 1 from ${schema.kestrelFiles} where ${schema.kestrelFiles.blobId} = ${schema.fileBlobs.id})`,
    ));
  }
  return candidates.length;
}

function toFileReference(file: FileRow): ConversationFileReference {
  return {
    type: "kestrel-file",
    fileId: file.id,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    mediaType: file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
    representationKind: file.representationStatus,
    status: file.lifecycleState,
  };
}

function validateSelection(fileIds: string[]): void {
  if (fileIds.length > CONVERSATION_ATTACHMENT_MAX_COUNT) throw new Error("A message can include at most 20 files.");
  if (new Set(fileIds).size !== fileIds.length) throw new Error("File IDs must be unique.");
}

function validateFileSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new FileUploadVerificationError("FILE_SIZE_MISMATCH");
  }
  if (sizeBytes > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES) {
    throw new FileUploadVerificationError("FILE_SIZE_EXCEEDED");
  }
}

class FileVerificationTransform extends Transform {
  readonly headerChunks: Buffer[] = [];
  readonly hash = createHash("sha256");
  sizeBytes = 0;
  constructor(private readonly expectedSizeBytes: number) { super(); }
  get header(): Buffer { return Buffer.concat(this.headerChunks).subarray(0, 512); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.sizeBytes += bytes.byteLength;
    if (this.sizeBytes > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES || this.sizeBytes > this.expectedSizeBytes) {
      callback(new FileUploadVerificationError("FILE_SIZE_EXCEEDED"));
      return;
    }
    if (this.header.length < 512) this.headerChunks.push(bytes.subarray(0, 512 - this.header.length));
    this.hash.update(bytes);
    callback(null, bytes);
  }
  result(): { sizeBytes: number; sha256: string } {
    if (this.sizeBytes !== this.expectedSizeBytes) {
      throw new FileUploadVerificationError("FILE_SIZE_MISMATCH");
    }
    return { sizeBytes: this.sizeBytes, sha256: this.hash.digest("hex") };
  }
}

function sanitizeFilename(value: string): string {
  const filename = value.trim().split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (!filename || filename === "." || filename === "..") throw new Error("File filename is invalid.");
  return filename.slice(0, 240);
}

function normalizeMediaType(value?: string | null): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized) ? normalized : undefined;
}

function detectMediaType(header: Buffer, filename: string, declared?: string): string {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return officeMediaType(filename, declared) ?? "application/zip";
  const normalized = normalizeMediaType(declared);
  if (normalized) return normalized;
  if (/\.(txt|md|markdown|csv|json|ya?ml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|sh|sql|xml|toml)$/iu.test(filename)) return "text/plain";
  return "application/octet-stream";
}

function officeMediaType(filename: string, declared?: string): string | undefined {
  const supported = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ];
  const normalized = normalizeMediaType(declared);
  if (normalized && supported.includes(normalized)) return normalized;
  if (/\.docx$/iu.test(filename)) return supported[0];
  if (/\.xlsx$/iu.test(filename)) return supported[1];
  if (/\.pptx$/iu.test(filename)) return supported[2];
  return;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
