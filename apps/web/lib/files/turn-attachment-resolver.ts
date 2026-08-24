import "server-only";

import {
  CONVERSATION_ATTACHMENT_MAX_COUNT,
  CONVERSATION_ATTACHMENT_MAX_FILE_BYTES,
  CONVERSATION_ATTACHMENT_MAX_TURN_BYTES,
} from "@kestrel-agents/conversation";
import type { RunnerTurnAttachment } from "@kestrel-agents/protocol";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { attachmentIdsFromMessageParts } from "@/lib/attachments/store";
import { ensureEffectiveFileAvailability, FileAvailabilityError } from "./availability";
import { modelVisibleMetadataOnlyReason } from "./representation";
import { getManagedFileStorageProvider, type FileStorageProvider } from "./storage-provider";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export type TurnAttachmentResolutionCode =
  | "ATTACHMENT_ACCESS_UNAUTHORIZED"
  | "ATTACHMENT_SET_INVALID"
  | "ATTACHMENT_UNAVAILABLE"
  | "ATTACHMENT_BLOB_MISSING"
  | "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE";

export class TurnAttachmentResolutionError extends Error {
  readonly code: TurnAttachmentResolutionCode;
  readonly retryable: boolean;
  readonly fileId?: string;

  constructor(input: {
    code: TurnAttachmentResolutionCode;
    message: string;
    retryable?: boolean;
    fileId?: string;
  }) {
    super(input.message);
    this.name = "TurnAttachmentResolutionError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.fileId = input.fileId;
  }
}

export type TurnAttachmentResolutionResponse = {
  version: 1;
  turnId: string;
  attachments: RunnerTurnAttachment[];
};

type ResolverFileRow = {
  fileId: string;
  fileOrganizationId: string;
  blobId: string;
  blobOrganizationId: string;
  objectKey: string;
  filename: string;
  declaredMediaType: string | null;
  detectedMediaType: string | null;
  sizeBytes: number;
  sha256: string | null;
  lifecycleState: "draft" | "ready" | "quarantined" | "failed" | "deleted";
  blobAvailabilityStatus: "unknown" | "available" | "missing";
  blobDeletedAt: Date | null;
  blobScanStatus: "pending" | "clean" | "quarantined" | "unavailable";
  ordinal: number;
  createdAt: Date;
};

type RepresentationRow = {
  blobId: string;
  kind: "native_image" | "extracted_text" | "metadata_only";
  textContent: string | null;
  truncated: boolean;
  error: string | null;
};

/**
 * Resolve a running durable turn without accepting any caller-selected
 * organization, Thread, message, or file identity. The turn and message
 * links are the sole source of attachment scope.
 */
export async function resolveTurnAttachments(input: {
  turnId: string;
  storage?: FileStorageProvider | undefined;
  now?: Date | undefined;
}): Promise<TurnAttachmentResolutionResponse> {
  const [turn] = await knowledgeDb
    .select({
      id: schema.threadTurns.id,
      organizationId: schema.threadTurns.organizationId,
      threadId: schema.threadTurns.threadId,
      threadOrganizationId: schema.threads.organizationId,
      inputMessageId: schema.threadTurns.inputMessageId,
      messageParts: schema.threadMessages.parts,
    })
    .from(schema.threadTurns)
    .innerJoin(
      schema.threadTurnQueueState,
      and(
        eq(schema.threadTurnQueueState.threadId, schema.threadTurns.threadId),
        eq(schema.threadTurnQueueState.activeTurnId, schema.threadTurns.id),
      ),
    )
    .innerJoin(
      schema.threads,
      eq(schema.threads.id, schema.threadTurns.threadId),
    )
    .leftJoin(
      schema.threadMessages,
      eq(schema.threadMessages.id, schema.threadTurns.inputMessageId),
    )
    .where(
      and(
        eq(schema.threadTurns.id, input.turnId),
        eq(schema.threadTurns.status, "running"),
      ),
    )
    .limit(1);

  if (
    !(turn && turn.inputMessageId && turn.messageParts) ||
    turn.threadOrganizationId !== turn.organizationId
  ) {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable turn is not an active running turn.",
    );
  }

  let messageFileIds: string[];
  try {
    messageFileIds = attachmentIdsFromMessageParts(turn.messageParts);
  } catch {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable attachment message is invalid.",
    );
  }

  const rows = (await knowledgeDb
    .select({
      fileId: schema.kestrelFiles.id,
      fileOrganizationId: schema.kestrelFiles.organizationId,
      blobId: schema.fileBlobs.id,
      blobOrganizationId: schema.fileBlobs.organizationId,
      objectKey: schema.fileBlobs.objectKey,
      filename: schema.kestrelFiles.filename,
      declaredMediaType: schema.kestrelFiles.declaredMediaType,
      detectedMediaType: schema.kestrelFiles.detectedMediaType,
      sizeBytes: schema.kestrelFiles.sizeBytes,
      sha256: schema.kestrelFiles.sha256,
      lifecycleState: schema.kestrelFiles.lifecycleState,
      blobAvailabilityStatus: schema.fileBlobs.availabilityStatus,
      blobDeletedAt: schema.fileBlobs.deletedAt,
      blobScanStatus: schema.fileBlobs.scanStatus,
      ordinal: schema.threadMessageFiles.ordinal,
      createdAt: schema.kestrelFiles.createdAt,
    })
    .from(schema.threadMessageFiles)
    .innerJoin(
      schema.threadMessages,
      and(
        eq(schema.threadMessages.id, schema.threadMessageFiles.messageId),
        eq(schema.threadMessages.threadId, turn.threadId),
        eq(schema.threadMessages.role, "user"),
      ),
    )
    .innerJoin(
      schema.kestrelFiles,
      eq(schema.kestrelFiles.id, schema.threadMessageFiles.fileId),
    )
    .innerJoin(
      schema.fileBlobs,
      eq(schema.fileBlobs.id, schema.kestrelFiles.blobId),
    )
    .where(eq(schema.threadMessageFiles.messageId, turn.inputMessageId))
    .orderBy(asc(schema.threadMessageFiles.ordinal))) as ResolverFileRow[];

  if (rows.length > CONVERSATION_ATTACHMENT_MAX_COUNT) {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable attachment set exceeds the per-message limit.",
    );
  }

  if (rows.some((row, index) => row.ordinal !== index)) {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable attachment order is invalid.",
    );
  }

  const fileIds = rows.map((row) => row.fileId);
  if (
    fileIds.length !== messageFileIds.length ||
    fileIds.some((fileId, index) => fileId !== messageFileIds[index])
  ) {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable attachment message and links do not match.",
    );
  }
  if (new Set(fileIds).size !== fileIds.length) {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable attachment set contains duplicates.",
    );
  }

  if (rows.length === 0) {
    return { version: 1, turnId: turn.id, attachments: [] };
  }

  const grants = await knowledgeDb
    .select({ fileId: schema.fileScopeGrants.fileId })
    .from(schema.fileScopeGrants)
    .where(
      and(
        eq(schema.fileScopeGrants.organizationId, turn.organizationId),
        eq(schema.fileScopeGrants.scopeType, "thread"),
        eq(schema.fileScopeGrants.threadId, turn.threadId),
        isNull(schema.fileScopeGrants.revokedAt),
        inArray(schema.fileScopeGrants.fileId, fileIds),
      ),
    );
  const grantedFileIds = new Set(grants.map((grant) => grant.fileId));
  if (
    grantedFileIds.size !== fileIds.length ||
    fileIds.some((fileId) => !grantedFileIds.has(fileId))
  ) {
    throw resolverError(
      "ATTACHMENT_UNAVAILABLE",
      "One or more attached files are no longer available to this Thread.",
    );
  }

  const totalBytes = rows.reduce((total, row) => total + row.sizeBytes, 0);
  if (
    totalBytes > CONVERSATION_ATTACHMENT_MAX_TURN_BYTES ||
    rows.some(
      (row) =>
        !Number.isSafeInteger(row.sizeBytes) ||
        row.sizeBytes < 0 ||
        row.sizeBytes > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES,
    )
  ) {
    throw resolverError(
      "ATTACHMENT_SET_INVALID",
      "The durable attachment set exceeds the file-size limits.",
    );
  }

  for (const row of rows) {
    if (
      row.fileOrganizationId !== turn.organizationId ||
      row.blobOrganizationId !== turn.organizationId ||
      row.lifecycleState !== "ready" ||
      row.blobScanStatus === "quarantined" ||
      !row.sha256 ||
      !(row.detectedMediaType ?? row.declaredMediaType)
    ) {
      throw resolverError(
        "ATTACHMENT_UNAVAILABLE",
        "One or more attached files are unavailable.",
        row.fileId,
      );
    }
  }

  const storage = input.storage ?? getManagedFileStorageProvider();
  await Promise.all(
    rows.map(async (row) => {
      try {
        await ensureEffectiveFileAvailability({
          fileId: row.fileId,
          lifecycleState: row.lifecycleState,
          blobId: row.blobId,
          objectKey: row.objectKey,
          availabilityStatus: row.blobAvailabilityStatus,
          blobDeletedAt: row.blobDeletedAt,
          storage,
          now: input.now,
        });
      } catch (error) {
        if (error instanceof FileAvailabilityError) {
          const code =
            error.code === "ATTACHMENT_BLOB_MISSING" ||
            error.code === "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE"
              ? error.code
              : "ATTACHMENT_UNAVAILABLE";
          throw resolverError(code, error.message, row.fileId, error.retryable);
        }
        throw error;
      }
    }),
  );

  const representations = (await knowledgeDb
    .select({
      blobId: schema.fileRepresentations.blobId,
      kind: schema.fileRepresentations.kind,
      textContent: schema.fileRepresentations.textContent,
      truncated: schema.fileRepresentations.truncated,
      error: schema.fileRepresentations.error,
    })
    .from(schema.fileRepresentations)
    .where(inArray(schema.fileRepresentations.blobId, rows.map((row) => row.blobId)))) as RepresentationRow[];
  const representationsByBlob = new Map<string, RepresentationRow>();
  for (const representation of representations) {
    if (!representationsByBlob.has(representation.blobId)) {
      representationsByBlob.set(representation.blobId, representation);
    }
  }

  const attachments = await Promise.all(
    rows.map(async (row) => {
      if (!storage.signedReadUrl) {
        throw resolverError(
          "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
          "The attachment service cannot mint temporary file access.",
          row.fileId,
          true,
        );
      }
      let sourceUrl: string;
      try {
        sourceUrl = await storage.signedReadUrl(row.objectKey, 900);
      } catch {
        throw resolverError(
          "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
          "The attachment service could not mint temporary file access.",
          row.fileId,
          true,
        );
      }
      const representation = representationsByBlob.get(row.blobId);
      const representationStatus = representation?.kind ?? "metadata_only";
      const kind =
        representationStatus === "native_image"
          ? "image"
          : representationStatus === "extracted_text"
            ? "text"
            : "file";
      const metadataOnlyReason = modelVisibleMetadataOnlyReason(
        representationStatus,
        representation?.error,
      );
      return {
        fileId: row.fileId,
        attachmentId: row.fileId,
        threadId: turn.threadId,
        filename: row.filename,
        mimeType: row.detectedMediaType ?? row.declaredMediaType ?? "application/octet-stream",
        sizeBytes: row.sizeBytes,
        sha256: row.sha256!,
        kind,
        representationStatus,
        createdAt: row.createdAt.toISOString(),
        sourceUrl,
        sourceUrlExpiresAt: new Date(
          (input.now ?? new Date()).getTime() + 15 * 60 * 1000,
        ).toISOString(),
        ...(representation?.textContent
          ? {
              text: representation.textContent,
              ...(representation.truncated ? { textTruncated: true } : {}),
            }
          : {}),
        ...(metadataOnlyReason ? { metadataOnlyReason } : {}),
      } satisfies RunnerTurnAttachment;
    }),
  );

  const [stillActive] = await knowledgeDb
    .select({ id: schema.threadTurns.id })
    .from(schema.threadTurnQueueState)
    .innerJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.threadTurnQueueState.activeTurnId),
    )
    .where(
      and(
        eq(schema.threadTurnQueueState.threadId, turn.threadId),
        eq(schema.threadTurnQueueState.activeTurnId, input.turnId),
        eq(schema.threadTurns.status, "running"),
      ),
    )
    .limit(1);
  if (!stillActive) {
    throw resolverError(
      "ATTACHMENT_ACCESS_UNAUTHORIZED",
      "The durable turn is no longer active.",
    );
  }

  return { version: 1, turnId: turn.id, attachments };
}

function resolverError(
  code: TurnAttachmentResolutionCode,
  message: string,
  fileId?: string,
  retryable = code === "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
) {
  return new TurnAttachmentResolutionError({
    code,
    message,
    retryable,
    ...(fileId ? { fileId } : {}),
  });
}
