import "server-only";

import { createHash } from "node:crypto";
import {
  getManagedFileStorageProvider,
} from "@/lib/files/storage-provider";
import { resolveReadyThreadFiles } from "@/lib/files/service";
import { type GmailRuntimeInput } from "./gmail-contract";
import { getGmailReplyTarget } from "./gmail-api";

type GmailMutationInput = Extract<
  GmailRuntimeInput,
  { operation: "gmail.messages.send" | "gmail.messages.reply" }
>;

export type GmailPreparedAttachment = {
  fileId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};

export type PreparedGmailMutation = {
  approvalPayload: Record<string, unknown>;
  envelope: {
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    html?: string | undefined;
    threadId?: string | undefined;
    replyHeaders?: { inReplyTo: string; references?: string | undefined } | undefined;
  };
  attachments: GmailPreparedAttachment[];
};

/**
 * Reconstructs the exact Gmail payload persisted at approval time. Runtime
 * execution consumes this payload before it obtains an OAuth credential, so a
 * reply cannot re-resolve provider state after the user has approved it.
 */
export function parsePreparedGmailMutationApproval(
  value: unknown,
): PreparedGmailMutation {
  const payload = asRecord(value, "Gmail approval payload");
  const operation = requiredString(payload.operation, "Gmail approval operation");
  const attachments = parsePreparedAttachments(payload.attachments);
  if (operation === "gmail.messages.send") {
    const envelope = parseEnvelope(payload.envelope, "Gmail send approval envelope");
    return { approvalPayload: payload, envelope, attachments };
  }
  if (operation === "gmail.messages.reply") {
    const target = asRecord(payload.replyTarget, "Gmail reply approval target");
    const body = asRecord(payload.body, "Gmail reply approval body");
    const inReplyTo = requiredString(target.inReplyTo, "Gmail reply in-reply-to");
    const references = optionalString(target.references, "Gmail reply references");
    const html = optionalString(body.html, "Gmail reply HTML");
    return {
      approvalPayload: payload,
      envelope: {
        to: stringArray(target.recipients, "Gmail reply recipients"),
        cc: [],
        subject: requiredString(target.subject, "Gmail reply subject"),
        text: requiredString(body.text, "Gmail reply text"),
        threadId: requiredString(target.threadId, "Gmail reply thread ID"),
        replyHeaders: {
          inReplyTo,
          ...(references === undefined ? {} : { references }),
        },
        ...(html === undefined ? {} : { html }),
      },
      attachments,
    };
  }
  throw new Error("Gmail approval operation is invalid.");
}

/**
 * Resolves provider-owned reply state and Thread-file identity before an
 * approval is recorded. The returned payload is the sole approval binding.
 */
export async function prepareGmailMutation(input: {
  accessToken: string;
  operation: GmailMutationInput;
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<PreparedGmailMutation> {
  const attachments = await resolveGmailAttachments({
    attachmentFileIds: input.operation.attachmentFileIds,
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (input.operation.operation === "gmail.messages.send") {
    const envelope = {
      to: [...input.operation.to],
      cc: [...input.operation.cc],
      subject: input.operation.subject,
      text: input.operation.text,
      ...(input.operation.html === undefined ? {} : { html: input.operation.html }),
    };
    return {
      envelope,
      attachments,
      approvalPayload: {
        operation: input.operation.operation,
        envelope,
        attachments,
      },
    };
  }
  const target = await getGmailReplyTarget({
    accessToken: input.accessToken,
    messageId: input.operation.messageId,
  });
  const envelope = {
    to: target.recipients,
    cc: [],
    subject: target.subject,
    text: input.operation.text,
    ...(input.operation.html === undefined ? {} : { html: input.operation.html }),
    threadId: target.threadId,
    replyHeaders: {
      inReplyTo: target.inReplyTo,
      ...(target.references === undefined ? {} : { references: target.references }),
    },
  };
  return {
    envelope,
    attachments,
    approvalPayload: {
      operation: input.operation.operation,
      replyTarget: {
        messageId: input.operation.messageId,
        threadId: target.threadId,
        recipients: target.recipients,
        subject: target.subject,
        inReplyTo: target.inReplyTo,
        ...(target.references === undefined ? {} : { references: target.references }),
      },
      body: {
        text: input.operation.text,
        ...(input.operation.html === undefined ? {} : { html: input.operation.html }),
      },
      attachments,
    },
  };
}

/** Re-resolve and verify every approved attachment immediately before send. */
export async function materializePreparedGmailAttachments(input: {
  attachments: readonly GmailPreparedAttachment[];
  threadId: string;
  organizationId: string;
  userId: string;
}) {
  const files = await resolveReadyThreadFiles({
    fileIds: input.attachments.map((attachment) => attachment.fileId),
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const storage = getManagedFileStorageProvider();
  return await Promise.all(files.map(async (file, index) => {
    const approved = input.attachments[index];
    if (
      !approved ||
      approved.fileId !== file.id ||
      approved.filename !== file.filename ||
      approved.mediaType !== file.detectedMediaType ||
      approved.sizeBytes !== file.sizeBytes ||
      approved.sha256 !== file.sha256
    ) {
      throw new Error("Gmail attachment approval no longer matches the current Thread file.");
    }
    const bytes = await storage.readBuffer(file.objectKey);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== approved.sizeBytes || sha256 !== approved.sha256) {
      throw new Error("Gmail attachment contents changed after approval.");
    }
    return {
      filename: approved.filename,
      mediaType: approved.mediaType,
      bytes,
    };
  }));
}

async function resolveGmailAttachments(input: {
  attachmentFileIds: string[];
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<GmailPreparedAttachment[]> {
  const files = await resolveReadyThreadFiles({
    fileIds: input.attachmentFileIds,
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  return files.map((file) => ({
    fileId: file.id,
    filename: file.filename,
    mediaType: file.detectedMediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  }));
}

function parseEnvelope(value: unknown, label: string): PreparedGmailMutation["envelope"] {
  const envelope = asRecord(value, label);
  const html = optionalString(envelope.html, `${label} HTML`);
  const threadId = optionalString(envelope.threadId, `${label} thread ID`);
  const replyHeaders = envelope.replyHeaders === undefined
    ? undefined
    : parseReplyHeaders(envelope.replyHeaders, `${label} reply headers`);
  return {
    to: stringArray(envelope.to, `${label} recipients`),
    cc: stringArray(envelope.cc, `${label} CC recipients`),
    subject: requiredString(envelope.subject, `${label} subject`),
    text: requiredString(envelope.text, `${label} text`),
    ...(html === undefined ? {} : { html }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(replyHeaders === undefined ? {} : { replyHeaders }),
  };
}

function parsePreparedAttachments(value: unknown): GmailPreparedAttachment[] {
  if (!Array.isArray(value)) throw new Error("Gmail approval attachments are invalid.");
  return value.map((candidate) => {
    const attachment = asRecord(candidate, "Gmail approval attachment");
    return {
      fileId: requiredString(attachment.fileId, "Gmail approval attachment file ID"),
      filename: requiredString(attachment.filename, "Gmail approval attachment filename"),
      mediaType: requiredString(attachment.mediaType, "Gmail approval attachment media type"),
      sizeBytes: requiredPositiveInteger(attachment.sizeBytes, "Gmail approval attachment size"),
      sha256: requiredString(attachment.sha256, "Gmail approval attachment hash"),
    };
  });
}

function parseReplyHeaders(value: unknown, label: string) {
  const headers = asRecord(value, label);
  const references = optionalString(headers.references, `${label} references`);
  return {
    inReplyTo: requiredString(headers.inReplyTo, `${label} in-reply-to`),
    ...(references === undefined ? {} : { references }),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown, label: string) {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} is invalid.`);
  }
  return [...value] as string[];
}

function requiredPositiveInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
