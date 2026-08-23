import "server-only";

import { Readable } from "node:stream";
import {
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILENAME,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_MEDIA_TYPE,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_SIZE_BYTES,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_TEXT,
  TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID,
  type RunnerTurnAttachment,
} from "@kestrel-agents/protocol";
import {
  getManagedFileStorageProvider,
  type FileStorageProvider,
} from "./storage-provider";

const CANARY_URL_TTL_SECONDS = 300;

export async function resolveTurnAttachmentDeploymentCanary(input: {
  storage?: FileStorageProvider | undefined;
  now?: Date | undefined;
} = {}) {
  const storage = input.storage ?? getManagedFileStorageProvider();
  if (!storage.signedReadUrl) {
    throw new Error("The attachment canary requires signed object access.");
  }
  const objectKey = storage.buildOriginalKey({
    organizationId: "deployment-canary",
    blobId: "turn-attachment-v1",
  });
  await storage.putStream({
    key: objectKey,
    body: Readable.from(Buffer.from(TURN_ATTACHMENT_DEPLOYMENT_CANARY_TEXT, "utf8")),
    contentType: TURN_ATTACHMENT_DEPLOYMENT_CANARY_MEDIA_TYPE,
    contentDisposition: `attachment; filename="${TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILENAME}"`,
  });
  const sourceUrl = await storage.signedReadUrl(
    objectKey,
    CANARY_URL_TTL_SECONDS,
  );
  const now = input.now ?? new Date();
  const attachment = {
    attachmentId: TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID,
    fileId: TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILE_ID,
    threadId: "deployment-canary-thread-v1",
    filename: TURN_ATTACHMENT_DEPLOYMENT_CANARY_FILENAME,
    mimeType: TURN_ATTACHMENT_DEPLOYMENT_CANARY_MEDIA_TYPE,
    sizeBytes: TURN_ATTACHMENT_DEPLOYMENT_CANARY_SIZE_BYTES,
    sha256: TURN_ATTACHMENT_DEPLOYMENT_CANARY_SHA256,
    kind: "text",
    representationStatus: "extracted_text",
    createdAt: now.toISOString(),
    sourceUrl,
    sourceUrlExpiresAt: new Date(
      now.getTime() + CANARY_URL_TTL_SECONDS * 1000,
    ).toISOString(),
  } satisfies RunnerTurnAttachment;
  return {
    version: 1 as const,
    turnId: TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID,
    attachments: [attachment],
  };
}
