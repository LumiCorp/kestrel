import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { processStoredFileRepresentation } from "@/lib/files/service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getStorageAdapter } from "@/lib/storage";

export type LegacyAttachmentBackfillResult = {
  scannedMessages: number;
  registeredAttachments: number;
  missingObjects: number;
};

export async function backfillLegacyThreadAttachments(
  limit = 100,
): Promise<LegacyAttachmentBackfillResult> {
  const source = "legacy_thread_message_files_v1";
  const progress = await knowledgeDb.query.fileBackfillProgress.findFirst({
    where: eq(schema.fileBackfillProgress.source, source),
  });
  await knowledgeDb.insert(schema.fileBackfillProgress).values({
    source,
    status: "running",
    error: null,
  }).onConflictDoUpdate({
    target: schema.fileBackfillProgress.source,
    set: { status: "running", error: null, updatedAt: new Date() },
  });
  const messages = await knowledgeDb
    .select({
      id: schema.threadMessages.id,
      threadId: schema.threadMessages.threadId,
      parts: schema.threadMessages.parts,
      authorUserId: schema.threadMessages.authorUserId,
      createdAt: schema.threadMessages.createdAt,
      organizationId: schema.threads.organizationId,
    })
    .from(schema.threadMessages)
    .innerJoin(schema.threads, eq(schema.threads.id, schema.threadMessages.threadId))
    .where(and(
      sql`${schema.threadMessages.parts} @> '[{"type":"file"}]'::jsonb`,
      progress?.cursorCreatedAt
        ? or(
            gt(schema.threadMessages.createdAt, progress.cursorCreatedAt),
            and(
              eq(schema.threadMessages.createdAt, progress.cursorCreatedAt),
              gt(schema.threadMessages.id, progress.cursorRecordId ?? ""),
            ),
          )
        : undefined,
    ))
    .orderBy(asc(schema.threadMessages.createdAt), asc(schema.threadMessages.id))
    .limit(limit);

  const result: LegacyAttachmentBackfillResult = {
    scannedMessages: messages.length,
    registeredAttachments: 0,
    missingObjects: 0,
  };
  const storage = getStorageAdapter();
  let processedMessages = 0;

  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    const nextParts = [...message.parts];
    let changed = false;
    let fileOrdinal = 0;
    for (let ordinal = 0; ordinal < nextParts.length; ordinal += 1) {
      const part = asRecord(nextParts[ordinal]);
      if (part?.type === "data-kestrel-file" || part?.type === "data-kestrel-attachment") {
        fileOrdinal += 1;
        continue;
      }
      if (part?.type !== "file") continue;
      const pathname = typeof part.url === "string" ? legacyUploadPath(part.url) : undefined;
      const legacyIdentity = `${message.id}:${ordinal}:${typeof part.url === "string" ? part.url : "missing-url"}`;
      const objectKey = pathname
        ? storage.buildObjectKey("chat-uploads", ...pathname)
        : storage.buildObjectKey("legacy-unavailable", digest(legacyIdentity));
      const filename = sanitizeFilename(
        typeof part.filename === "string"
          ? part.filename
          : typeof part.name === "string"
            ? part.name
            : path.basename(pathname?.at(-1) ?? "file"),
      );
      const fileId = `file-legacy-${digest(`${message.id}:${ordinal}:${objectKey}`).slice(0, 32)}`;
      const declaredMediaType = typeof part.mediaType === "string"
        ? part.mediaType
        : typeof part.contentType === "string"
          ? part.contentType
          : "application/octet-stream";
      const exists = pathname !== undefined && await storage.objectExists(objectKey);
      const verified = exists ? await inspectObject(objectKey) : null;
      if (!verified) result.missingObjects += 1;
      const detectedMediaType = detectLegacyMediaType(verified?.header, filename, declaredMediaType);
      const blob = await findOrCreateBlob({
        organizationId: message.organizationId,
        objectKey,
        verified,
        availabilityStatus: pathname === undefined ? "unknown" : verified ? "available" : "missing",
        createdAt: message.createdAt,
      });
      const [insertedFile] = await knowledgeDb.insert(schema.kestrelFiles).values({
        id: fileId,
        organizationId: message.organizationId,
        uploaderUserId: message.authorUserId,
        blobId: blob.id,
        filename,
        declaredMediaType,
        detectedMediaType,
        sizeBytes: verified?.sizeBytes ?? 0,
        sha256: verified?.sha256 ?? null,
        lifecycleState: verified ? "ready" : "failed",
        createdAt: message.createdAt,
      }).onConflictDoNothing({ target: schema.kestrelFiles.id }).returning();
      const file = insertedFile ?? await knowledgeDb.query.kestrelFiles.findFirst({
        where: eq(schema.kestrelFiles.id, fileId),
      });
      if (!file) continue;
      await knowledgeDb.insert(schema.fileScopeGrants).values({
        id: `grant-legacy-${digest(`${file.id}:${message.threadId}`).slice(0, 32)}`,
        fileId: file.id,
        organizationId: message.organizationId,
        scopeType: "thread",
        threadId: message.threadId,
        projectId: null,
        createdByUserId: message.authorUserId,
        createdAt: message.createdAt,
      }).onConflictDoNothing();
      await knowledgeDb.insert(schema.threadMessageFiles).values({
        messageId: message.id,
        fileId: file.id,
        ordinal: fileOrdinal,
      }).onConflictDoNothing();
      fileOrdinal += 1;
      if (verified && insertedFile) {
        await processStoredFileRepresentation({
          blobId: blob.id,
          objectKey: blob.objectKey,
          filename,
          mediaType: detectedMediaType,
        });
      } else if (!verified) {
        await knowledgeDb.insert(schema.fileRepresentations).values({
          id: `representation-legacy-${digest(file.id).slice(0, 32)}`,
          blobId: blob.id,
          kind: "metadata_only",
          status: "failed",
          mediaType: detectedMediaType,
          error: pathname === undefined
            ? "The legacy file did not reference a Kestrel-managed object."
            : "The referenced legacy object is unavailable.",
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        }).onConflictDoNothing();
      }
      nextParts[ordinal] = {
        type: "data-kestrel-file",
        data: {
          type: "kestrel-file",
          fileId: file.id,
          filename: file.filename,
          sizeBytes: file.sizeBytes,
          mediaType: file.detectedMediaType ?? declaredMediaType,
          representationKind: verified ? classifyLegacyRepresentation(detectedMediaType) : "metadata_only",
          status: file.lifecycleState,
        },
      };
      changed = true;
      result.registeredAttachments += insertedFile ? 1 : 0;
      await knowledgeDb.insert(schema.fileBackfillResults).values({
        sourceKey: `${message.id}:${ordinal}`,
        source,
        fileId: file.id,
        status: verified ? "registered" : "missing",
        error: verified ? null : "The referenced legacy object is unavailable.",
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: schema.fileBackfillResults.sourceKey,
        set: {
          fileId: file.id,
          status: verified ? "registered" : "missing",
          error: verified ? null : "The referenced legacy object is unavailable.",
          updatedAt: new Date(),
        },
      });
    }
    if (changed) {
      await knowledgeDb.update(schema.threadMessages).set({ parts: nextParts }).where(and(
        eq(schema.threadMessages.id, message.id),
        eq(schema.threadMessages.threadId, message.threadId),
      ));
    }
    processedMessages += 1;
    await knowledgeDb.update(schema.fileBackfillProgress).set({
      cursorCreatedAt: message.createdAt,
      cursorRecordId: message.id,
      scannedCount: (progress?.scannedCount ?? 0) + processedMessages,
      registeredCount: (progress?.registeredCount ?? 0) + result.registeredAttachments,
      missingCount: (progress?.missingCount ?? 0) + result.missingObjects,
      updatedAt: new Date(),
    }).where(eq(schema.fileBackfillProgress.source, source));
  }
  await knowledgeDb.update(schema.fileBackfillProgress).set({
    status: messages.length < limit ? "completed" : "running",
    updatedAt: new Date(),
  }).where(eq(schema.fileBackfillProgress.source, source));
  return result;
}

async function findOrCreateBlob(input: {
  organizationId: string;
  objectKey: string;
  verified: Awaited<ReturnType<typeof inspectObject>> | null;
  availabilityStatus: "unknown" | "available" | "missing";
  createdAt: Date;
}) {
  const byObjectKey = await knowledgeDb.query.fileBlobs.findFirst({
    where: eq(schema.fileBlobs.objectKey, input.objectKey),
  });
  if (byObjectKey) return byObjectKey;
  if (input.verified) {
    const byHash = await knowledgeDb.query.fileBlobs.findFirst({
      where: (table, { and: andOp, eq: eqOp, isNull }) => andOp(
        eqOp(table.organizationId, input.organizationId),
        eqOp(table.sha256, input.verified?.sha256 as string),
        isNull(table.deletedAt),
      ),
    });
    if (byHash) return byHash;
  }
  const [blob] = await knowledgeDb.insert(schema.fileBlobs).values({
    id: `blob-legacy-${digest(`${input.organizationId}:${input.objectKey}`).slice(0, 32)}`,
    organizationId: input.organizationId,
    objectKey: input.objectKey,
    sizeBytes: input.verified?.sizeBytes ?? 0,
    sha256: input.verified?.sha256 ?? null,
    availabilityStatus: input.availabilityStatus,
    availabilityCheckedAt: input.availabilityStatus === "unknown" ? null : input.createdAt,
    scanStatus: "unavailable",
    createdAt: input.createdAt,
  }).onConflictDoNothing().returning();
  if (blob) return blob;
  const resolved = await knowledgeDb.query.fileBlobs.findFirst({
    where: (table, { or: orOp, eq: eqOp, and: andOp }) => orOp(
      eqOp(table.objectKey, input.objectKey),
      input.verified
        ? andOp(eqOp(table.organizationId, input.organizationId), eqOp(table.sha256, input.verified.sha256))
        : eqOp(table.id, ""),
    ),
  });
  if (!resolved) throw new Error("Legacy file blob could not be registered.");
  return resolved;
}

async function inspectObject(objectKey: string) {
  const stream = await getStorageAdapter().getObjectStream(objectKey);
  const hash = createHash("sha256");
  const headerChunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    hash.update(bytes);
    const headerSize = headerChunks.reduce((sum, entry) => sum + entry.byteLength, 0);
    if (headerSize < 512) headerChunks.push(bytes.subarray(0, 512 - headerSize));
  }
  return { sizeBytes, sha256: hash.digest("hex"), header: Buffer.concat(headerChunks) };
}

function legacyUploadPath(value: string): string[] | undefined {
  try {
    const pathname = new URL(value, "http://kestrel.local").pathname;
    const prefix = "/api/files/";
    if (!pathname.startsWith(prefix)) return;
    return pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return;
  }
}

function detectLegacyMediaType(header: Buffer | undefined, filename: string, declared: string): string {
  if (header?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header?.[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header?.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (/\.(txt|md|markdown|csv|json|ya?ml|html?)$/iu.test(filename)) return "text/plain";
  return declared || "application/octet-stream";
}

function classifyLegacyRepresentation(mediaType: string) {
  if (mediaType.startsWith("image/")) return "native_image" as const;
  if (mediaType.startsWith("text/") || mediaType === "application/pdf" || mediaType.includes("officedocument")) {
    return "extracted_text" as const;
  }
  return "metadata_only" as const;
}

function sanitizeFilename(value: string): string {
  return (value.trim().split(/[\\/]/u).at(-1)?.trim() || "file").slice(0, 240);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
