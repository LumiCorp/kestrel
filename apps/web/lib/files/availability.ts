import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { insertAdminEvent } from "@/lib/admin/logs";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getManagedFileStorageProvider } from "./storage-provider";

export type FileBlobAvailabilityStatus = "unknown" | "available" | "missing";

export type FileAvailabilityCode =
  | "ATTACHMENT_UNAVAILABLE"
  | "ATTACHMENT_BLOB_MISSING"
  | "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE"
  | "ATTACHMENT_BLOB_REPAIR_INTEGRITY_FAILED";

export class FileAvailabilityError extends Error {
  readonly code: FileAvailabilityCode;
  readonly retryable: boolean;
  readonly fileId?: string;
  readonly blobId?: string;

  constructor(input: {
    code: FileAvailabilityCode;
    message: string;
    retryable?: boolean;
    fileId?: string;
    blobId?: string;
  }) {
    super(input.message);
    this.name = "FileAvailabilityError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.fileId = input.fileId;
    this.blobId = input.blobId;
  }
}

type AvailabilityProbe = {
  exists(key: string): Promise<boolean>;
};

export async function ensureFileBlobAvailable(input: {
  blobId: string;
  objectKey: string;
  availabilityStatus: FileBlobAvailabilityStatus;
  deletedAt?: Date | null | undefined;
  storage?: AvailabilityProbe | undefined;
  now?: Date | undefined;
  fileId?: string | undefined;
}): Promise<void> {
  if (input.deletedAt) {
    throw unavailable(input);
  }
  if (input.availabilityStatus === "available") return;
  if (input.availabilityStatus === "missing") {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_BLOB_MISSING",
      message: "The attached file content is unavailable.",
      fileId: input.fileId,
      blobId: input.blobId,
    });
  }

  const checkedAt = input.now ?? new Date();
  let exists: boolean;
  try {
    exists = await (input.storage ?? getManagedFileStorageProvider()).exists(input.objectKey);
  } catch (error) {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
      message: "The attachment service could not confirm file availability.",
      retryable: true,
      fileId: input.fileId,
      blobId: input.blobId,
    });
  }

  await knowledgeDb.update(schema.fileBlobs).set({
    availabilityStatus: exists ? "available" : "missing",
    availabilityCheckedAt: checkedAt,
  }).where(and(
    eq(schema.fileBlobs.id, input.blobId),
    eq(schema.fileBlobs.availabilityStatus, "unknown"),
  ));

  const committed = await knowledgeDb.query.fileBlobs.findFirst({
    where: eq(schema.fileBlobs.id, input.blobId),
    columns: {
      availabilityStatus: true,
    },
  });

  if (committed?.availabilityStatus === "available") return;
  if (committed?.availabilityStatus !== "missing") {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
      message: "The attachment service could not confirm file availability.",
      retryable: true,
      fileId: input.fileId,
      blobId: input.blobId,
    });
  }

  throw new FileAvailabilityError({
    code: "ATTACHMENT_BLOB_MISSING",
    message: "The attached file content is unavailable.",
    fileId: input.fileId,
    blobId: input.blobId,
  });
}

export async function ensureEffectiveFileAvailability(input: {
  fileId: string;
  lifecycleState: string;
  blobId: string;
  objectKey: string;
  availabilityStatus: FileBlobAvailabilityStatus;
  blobDeletedAt?: Date | null | undefined;
  storage?: AvailabilityProbe | undefined;
  now?: Date | undefined;
}): Promise<void> {
  if (input.lifecycleState !== "ready") {
    throw unavailable({ fileId: input.fileId, blobId: input.blobId });
  }
  await ensureFileBlobAvailable({
    blobId: input.blobId,
    objectKey: input.objectKey,
    availabilityStatus: input.availabilityStatus,
    deletedAt: input.blobDeletedAt,
    storage: input.storage,
    now: input.now,
    fileId: input.fileId,
  });
}

/**
 * Confirm an operator's external restoration of a blob. A HEAD is not enough:
 * the complete object must be read and match both immutable integrity fields.
 */
export async function verifyRestoredFileBlob(input: {
  blobId: string;
  organizationId: string;
  actorUserId: string;
  storage?: {
    exists(key: string): Promise<boolean>;
    readBuffer(key: string): Promise<Buffer>;
  };
  now?: Date | undefined;
}) {
  const blob = await knowledgeDb.query.fileBlobs.findFirst({
    where: (table, operators) => operators.and(
      operators.eq(table.id, input.blobId),
      operators.eq(table.organizationId, input.organizationId),
    ),
  });
  if (!blob) throw new Error("File blob not found.");

  const storage = input.storage ?? getManagedFileStorageProvider();
  let exists: boolean;
  try {
    exists = await storage.exists(blob.objectKey);
  } catch {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
      message: "The attachment service could not confirm the restored file.",
      retryable: true,
      blobId: blob.id,
    });
  }
  if (!exists) {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_BLOB_MISSING",
      message: "The restored file content is still unavailable.",
      blobId: blob.id,
    });
  }

  let bytes: Buffer;
  try {
    bytes = await storage.readBuffer(blob.objectKey);
  } catch {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
      message: "The attachment service could not read the restored file.",
      retryable: true,
      blobId: blob.id,
    });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== blob.sizeBytes || !blob.sha256 || sha256 !== blob.sha256) {
    throw new FileAvailabilityError({
      code: "ATTACHMENT_BLOB_REPAIR_INTEGRITY_FAILED",
      message: "The restored file does not match its recorded integrity values.",
      blobId: blob.id,
    });
  }

  const checkedAt = input.now ?? new Date();
  const repaired = await knowledgeDb.transaction(async (transaction) => {
    const [updatedBlob] = await transaction
      .update(schema.fileBlobs)
      .set({
        availabilityStatus: "available",
        availabilityCheckedAt: checkedAt,
      })
      .where(eq(schema.fileBlobs.id, blob.id))
      .returning();
    if (!updatedBlob) throw new Error("File blob not found.");

    await insertAdminEvent(transaction, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: "file_blobs",
      action: "restore_verified",
      targetType: "file_blob",
      targetId: blob.id,
      message: `Verified restored file blob ${blob.id}.`,
      metadata: {
        sizeBytes: bytes.byteLength,
        sha256,
        availabilityCheckedAt: checkedAt.toISOString(),
      },
    });

    return updatedBlob;
  });
  return repaired;
}

function unavailable(input: { fileId?: string; blobId?: string }): FileAvailabilityError {
  return new FileAvailabilityError({
    code: "ATTACHMENT_UNAVAILABLE",
    message: "The attached file is unavailable.",
    fileId: input.fileId,
    blobId: input.blobId,
  });
}
