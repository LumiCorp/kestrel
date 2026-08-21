export const CONVERSATION_ATTACHMENT_MAX_COUNT = 20;
export const CONVERSATION_ATTACHMENT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const CONVERSATION_ATTACHMENT_MAX_TURN_BYTES = 500 * 1024 * 1024;
export const CONVERSATION_ATTACHMENT_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type KestrelFileLifecycleState =
  | "draft"
  | "ready"
  | "quarantined"
  | "failed"
  | "deleted";

export type KestrelFileScope =
  | { kind: "thread"; threadId: string }
  | { kind: "project"; projectId: string }
  | { kind: "organization"; organizationId: string };

export type KestrelFileRepresentation =
  | { kind: "native_image"; mediaType: string; width?: number | undefined; height?: number | undefined }
  | { kind: "extracted_text"; mediaType: string; truncated: boolean }
  | { kind: "staged_file"; mediaType: string }
  | { kind: "metadata_only"; reason: string };

export interface KestrelFile {
  fileId: string;
  organizationId: string;
  uploaderUserId?: string | undefined;
  filename: string;
  sizeBytes: number;
  sha256: string;
  declaredMediaType?: string | undefined;
  detectedMediaType: string;
  lifecycleState: KestrelFileLifecycleState;
  representation: KestrelFileRepresentation;
  scopes: KestrelFileScope[];
  createdAt: string;
}

/** The stable file reference persisted by every Kestrel conversation client. */
export interface ConversationFileReference {
  type: "kestrel-file";
  fileId: string;
  filename: string;
  sizeBytes: number;
  mediaType: string;
  representationKind: KestrelFileRepresentation["kind"];
  status: KestrelFileLifecycleState;
}

/** @deprecated Compatibility shape for clients that still call files attachments. */
export interface ConversationAttachmentReference {
  type: "kestrel-attachment";
  attachmentId: string;
  fileId: string;
  filename: string;
  sizeBytes: number;
  mediaType: string;
  representationKind: KestrelFileRepresentation["kind"];
  status: KestrelFileLifecycleState;
}

/** @deprecated Use KestrelFileLifecycleState. */
export type ConversationAttachmentLifecycleState = KestrelFileLifecycleState;
/** @deprecated Use KestrelFileRepresentation. */
export type ConversationAttachmentRepresentation = KestrelFileRepresentation;
/** @deprecated Use KestrelFile. */
export type ConversationAttachment = Omit<KestrelFile, "fileId" | "scopes"> & {
  attachmentId: string;
  threadId: string;
  submittedAt?: string | undefined;
};

export function assertConversationFileSelection(
  files: ReadonlyArray<Pick<KestrelFile, "fileId" | "sizeBytes">>,
): void {
  assertSelection(files.map((file) => ({ id: file.fileId, sizeBytes: file.sizeBytes })));
}

/** @deprecated Use assertConversationFileSelection. */
export function assertConversationAttachmentSelection(
  attachments: ReadonlyArray<Pick<ConversationAttachment, "attachmentId" | "sizeBytes">>,
): void {
  assertSelection(attachments.map((attachment) => ({ id: attachment.attachmentId, sizeBytes: attachment.sizeBytes })));
}

export function toConversationFileReference(file: KestrelFile): ConversationFileReference {
  return {
    type: "kestrel-file",
    fileId: file.fileId,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    mediaType: file.detectedMediaType,
    representationKind: file.representation.kind,
    status: file.lifecycleState,
  };
}

/** @deprecated Use toConversationFileReference. */
export function toConversationAttachmentReference(
  attachment: ConversationAttachment,
): ConversationAttachmentReference {
  return {
    type: "kestrel-attachment",
    attachmentId: attachment.attachmentId,
    fileId: attachment.attachmentId,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
    mediaType: attachment.detectedMediaType,
    representationKind: attachment.representation.kind,
    status: attachment.lifecycleState,
  };
}

function assertSelection(files: ReadonlyArray<{ id: string; sizeBytes: number }>): void {
  if (files.length > CONVERSATION_ATTACHMENT_MAX_COUNT) {
    throw new Error(`A message can include at most ${CONVERSATION_ATTACHMENT_MAX_COUNT} files.`);
  }
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (ids.has(file.id)) throw new Error("File IDs must be unique.");
    ids.add(file.id);
    if (
      Number.isSafeInteger(file.sizeBytes) === false
      || file.sizeBytes < 0
      || file.sizeBytes > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES
    ) {
      throw new Error(`Each file must be at most ${CONVERSATION_ATTACHMENT_MAX_FILE_BYTES} bytes.`);
    }
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > CONVERSATION_ATTACHMENT_MAX_TURN_BYTES) {
    throw new Error(`Files must total at most ${CONVERSATION_ATTACHMENT_MAX_TURN_BYTES} bytes per message.`);
  }
}
