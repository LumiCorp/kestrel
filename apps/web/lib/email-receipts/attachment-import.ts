import "server-only";

import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { and, eq, sql } from "drizzle-orm";
import { CONVERSATION_ATTACHMENT_MAX_FILE_BYTES } from "@kestrel-agents/conversation";
import { decryptReceivingApiKey } from "@/lib/email/receiving-config";
import {
  discardUnreferencedFile,
  FileUploadVerificationError,
  initializeThreadFile,
  uploadThreadFile,
} from "@/lib/files/service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  EmailReceiptProviderError,
  type ReceivedEmailProvider,
  ResendReceivedEmailProvider,
} from "./provider";

export type EmailAttachmentReadFailureCode =
  | "EMAIL_ATTACHMENT_UNAVAILABLE"
  | "EMAIL_ATTACHMENT_IMPORT_IN_PROGRESS"
  | "EMAIL_ATTACHMENT_PROVIDER_PERMANENT"
  | "EMAIL_ATTACHMENT_SIZE_EXCEEDED"
  | "EMAIL_ATTACHMENT_INTEGRITY_FAILED"
  | "EMAIL_ATTACHMENT_QUARANTINED"
  | "EMAIL_ATTACHMENT_REPRESENTATION_FAILED";

export class EmailAttachmentReadError extends Error {
  constructor(
    readonly code: EmailAttachmentReadFailureCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "EmailAttachmentReadError";
  }
}

type ImportTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

type ScopedAttachment = {
  attachmentId: string;
  importState: "available" | "importing" | "ready" | "failed";
  failureCode: string | null;
  fileId: string | null;
  filename: string | null;
  providerOrder: number;
  declaredMediaType: string | null;
  providerSizeBytes: number;
  providerAttachmentId: string;
  resendEmailId: string;
  encryptedApiKey: string;
};

export async function hasMaterializedEmailReceiptThread(input: {
  organizationId: string;
  threadId: string;
}): Promise<boolean> {
  const [receipt] = await knowledgeDb
    .select({ id: schema.emailDeliveryReceipts.id })
    .from(schema.emailDeliveryReceipts)
    .where(
      and(
        eq(schema.emailDeliveryReceipts.organizationId, input.organizationId),
        eq(schema.emailDeliveryReceipts.materializedThreadId, input.threadId),
        eq(schema.emailDeliveryReceipts.state, "materialized"),
      ),
    )
    .limit(1);
  return receipt !== undefined;
}

/**
 * Imports one opaque Delivery Attachment while holding the attachment's
 * database lock. The lock makes concurrent first reads converge on one file
 * without storing a provider URL or granting the runtime provider access.
 */
export async function importEmailDeliveryAttachment(input: {
  ticket: EnvironmentExecutionTicket;
  attachmentId: string;
  provider?: ReceivedEmailProvider | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<{ fileId: string }> {
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`email-delivery-attachment:${input.attachmentId}`}, 0))`,
    );
    const attachment = await readScopedAttachment(tx, input);
    if (attachment.importState === "ready" && attachment.fileId) {
      return { fileId: attachment.fileId };
    }
    if (attachment.importState === "failed") {
      throw new EmailAttachmentReadError(
        toFailureCode(attachment.failureCode),
        false,
      );
    }
    if (attachment.providerSizeBytes > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES) {
      await markAttachmentFailed(
        tx,
        attachment.attachmentId,
        "EMAIL_ATTACHMENT_SIZE_EXCEEDED",
      );
      throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_SIZE_EXCEEDED", false);
    }

    await tx
      .update(schema.emailDeliveryAttachments)
      .set({ importState: "importing", failureCode: null, updatedAt: new Date() })
      .where(eq(schema.emailDeliveryAttachments.id, attachment.attachmentId));

    let fileId: string | undefined;
    try {
      const apiKey = decryptReceivingApiKey({
        organizationId: input.ticket.organizationId,
        encryptedApiKey: attachment.encryptedApiKey,
        env: input.env,
      });
      const download = await (
        input.provider ?? new ResendReceivedEmailProvider()
      ).downloadAttachment({
        apiKey,
        emailId: attachment.resendEmailId,
        providerAttachmentId: attachment.providerAttachmentId,
      });
      if (
        download.contentLength !== undefined &&
        download.contentLength !== attachment.providerSizeBytes
      ) {
        throw new FileUploadVerificationError("FILE_SIZE_MISMATCH");
      }
      const initialized = await initializeThreadFile({
        threadId: input.ticket.threadId,
        organizationId: input.ticket.organizationId,
        userId: input.ticket.actorId,
        filename: attachment.filename ?? `attachment-${attachment.providerOrder + 1}`,
        sizeBytes: attachment.providerSizeBytes,
        ...(attachment.declaredMediaType
          ? { declaredMediaType: attachment.declaredMediaType }
          : {}),
      });
      fileId = initialized.id;
      const uploaded = await uploadThreadFile({
        fileId,
        threadId: input.ticket.threadId,
        organizationId: input.ticket.organizationId,
        userId: input.ticket.actorId,
        body: download.body,
        ...(download.contentLength !== undefined
          ? { contentLength: download.contentLength }
          : {}),
      });
      if (uploaded.lifecycleState === "quarantined") {
        throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_QUARANTINED", false);
      }
      const representation = await knowledgeDb.query.fileRepresentations.findFirst({
        where: (table, { eq: eqOp }) => eqOp(table.blobId, uploaded.blobId),
        columns: { status: true },
      });
      if (representation?.status === "failed") {
        throw new EmailAttachmentReadError(
          "EMAIL_ATTACHMENT_REPRESENTATION_FAILED",
          false,
        );
      }
      await tx
        .update(schema.emailDeliveryAttachments)
        .set({
          importState: "ready",
          failureCode: null,
          fileId,
          updatedAt: new Date(),
        })
        .where(eq(schema.emailDeliveryAttachments.id, attachment.attachmentId));
      return { fileId };
    } catch (error) {
      if (fileId) {
        await discardUnreferencedFile(fileId, { removeScopeGrants: true }).catch(
          () => {},
        );
      }
      if (error instanceof EmailReceiptProviderError && error.retryable) {
        await resetAttachmentAvailable(tx, attachment.attachmentId);
        throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_UNAVAILABLE", true);
      }
      const failure = classifyImportFailure(error);
      if (
        failure.retryable ||
        failure.code === "EMAIL_ATTACHMENT_UNAVAILABLE" ||
        failure.code === "EMAIL_ATTACHMENT_IMPORT_IN_PROGRESS"
      ) {
        await resetAttachmentAvailable(tx, attachment.attachmentId);
      } else {
        await markAttachmentFailed(tx, attachment.attachmentId, failure.code);
      }
      throw failure;
    }
  });
}

async function readScopedAttachment(
  tx: ImportTransaction,
  input: { ticket: EnvironmentExecutionTicket; attachmentId: string },
): Promise<ScopedAttachment> {
  const [execution] = await tx
    .select({
      id: schema.environmentRunExecutions.id,
      projectId: schema.environmentRunExecutions.projectId,
    })
    .from(schema.environmentRunExecutions)
    .where(and(
      eq(schema.environmentRunExecutions.id, input.ticket.runId),
      eq(schema.environmentRunExecutions.organizationId, input.ticket.organizationId),
      eq(schema.environmentRunExecutions.environmentId, input.ticket.environmentId),
      eq(schema.environmentRunExecutions.workspaceId, input.ticket.workspaceId),
      eq(schema.environmentRunExecutions.threadId, input.ticket.threadId),
      eq(schema.environmentRunExecutions.actorId, input.ticket.actorId),
      eq(schema.environmentRunExecutions.status, "running"),
    ))
    .limit(1)
    .for("update");
  if (!execution) throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_UNAVAILABLE", false);

  const [attachment] = await tx
    .select({
      attachmentId: schema.emailDeliveryAttachments.id,
      importState: schema.emailDeliveryAttachments.importState,
      failureCode: schema.emailDeliveryAttachments.failureCode,
      fileId: schema.emailDeliveryAttachments.fileId,
      filename: schema.emailDeliveryAttachments.filename,
      providerOrder: schema.emailDeliveryAttachments.providerOrder,
      declaredMediaType: schema.emailDeliveryAttachments.declaredMediaType,
      providerSizeBytes: schema.emailDeliveryAttachments.providerSizeBytes,
      providerAttachmentId: schema.emailDeliveryAttachments.providerAttachmentId,
      resendEmailId: schema.emailDeliveryReceipts.resendEmailId,
      encryptedApiKey: schema.organizationReceivingConnections.encryptedApiKey,
      executionOwnerUserId: schema.projectEmailTriggers.executionOwnerUserId,
      projectId: schema.projectEmailTriggers.projectId,
      credentialStatus: schema.organizationReceivingConnections.credentialStatus,
      inboundEnabled: schema.organizationReceivingConnections.inboundEnabled,
      webhookStatus: schema.organizationReceivingConnections.webhookStatus,
      organizationState: schema.organizations.lifecycleState,
    })
    .from(schema.emailDeliveryAttachments)
    .innerJoin(
      schema.emailDeliveryReceipts,
      and(
        eq(schema.emailDeliveryReceipts.id, schema.emailDeliveryAttachments.receiptId),
        eq(schema.emailDeliveryReceipts.organizationId, schema.emailDeliveryAttachments.organizationId),
      ),
    )
    .innerJoin(
      schema.projectEmailTriggers,
      and(
        eq(schema.projectEmailTriggers.id, schema.emailDeliveryReceipts.triggerId),
        eq(schema.projectEmailTriggers.organizationId, schema.emailDeliveryReceipts.organizationId),
      ),
    )
    .innerJoin(
      schema.organizationReceivingConnections,
      and(
        eq(schema.organizationReceivingConnections.id, schema.emailDeliveryReceipts.receivingConnectionId),
        eq(schema.organizationReceivingConnections.organizationId, schema.emailDeliveryReceipts.organizationId),
      ),
    )
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.emailDeliveryReceipts.organizationId),
    )
    .where(and(
      eq(schema.emailDeliveryAttachments.id, input.attachmentId),
      eq(schema.emailDeliveryAttachments.organizationId, input.ticket.organizationId),
      eq(schema.emailDeliveryReceipts.materializedThreadId, input.ticket.threadId),
      eq(schema.emailDeliveryReceipts.state, "materialized"),
    ))
    .limit(1)
    .for("update");
  if (!attachment) {
    throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_UNAVAILABLE", false);
  }
  const encryptedApiKey = attachment.encryptedApiKey;
  if (
    attachment.executionOwnerUserId !== input.ticket.actorId ||
    attachment.projectId !== execution.projectId ||
    !encryptedApiKey ||
    attachment.credentialStatus !== "full_access" ||
    !attachment.inboundEnabled ||
    attachment.webhookStatus !== "active" ||
    attachment.organizationState !== "active"
  ) {
    throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_UNAVAILABLE", false);
  }
  const [access] = await tx
    .select({ id: schema.projectMembers.organizationMemberId })
    .from(schema.projectMembers)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.ticket.organizationId),
        eq(schema.members.userId, input.ticket.actorId),
      ),
    )
    .where(eq(schema.projectMembers.projectId, attachment.projectId))
    .limit(1);
  if (!access) throw new EmailAttachmentReadError("EMAIL_ATTACHMENT_UNAVAILABLE", false);
  return { ...attachment, encryptedApiKey };
}

function classifyImportFailure(error: unknown): EmailAttachmentReadError {
  if (error instanceof EmailAttachmentReadError) return error;
  if (error instanceof EmailReceiptProviderError) {
    return new EmailAttachmentReadError("EMAIL_ATTACHMENT_PROVIDER_PERMANENT", false);
  }
  if (error instanceof FileUploadVerificationError) {
    return new EmailAttachmentReadError(
      error.code === "FILE_SIZE_EXCEEDED"
        ? "EMAIL_ATTACHMENT_SIZE_EXCEEDED"
        : "EMAIL_ATTACHMENT_INTEGRITY_FAILED",
      false,
    );
  }
  return new EmailAttachmentReadError("EMAIL_ATTACHMENT_UNAVAILABLE", true);
}

function toFailureCode(value: string | null): EmailAttachmentReadFailureCode {
  return value === "EMAIL_ATTACHMENT_PROVIDER_PERMANENT" ||
    value === "EMAIL_ATTACHMENT_SIZE_EXCEEDED" ||
    value === "EMAIL_ATTACHMENT_INTEGRITY_FAILED" ||
    value === "EMAIL_ATTACHMENT_QUARANTINED" ||
    value === "EMAIL_ATTACHMENT_REPRESENTATION_FAILED"
    ? value
    : "EMAIL_ATTACHMENT_UNAVAILABLE";
}

async function resetAttachmentAvailable(tx: ImportTransaction, attachmentId: string) {
  await tx
    .update(schema.emailDeliveryAttachments)
    .set({ importState: "available", failureCode: null, fileId: null, updatedAt: new Date() })
    .where(eq(schema.emailDeliveryAttachments.id, attachmentId));
}

async function markAttachmentFailed(
  tx: ImportTransaction,
  attachmentId: string,
  failureCode: Exclude<EmailAttachmentReadFailureCode, "EMAIL_ATTACHMENT_UNAVAILABLE" | "EMAIL_ATTACHMENT_IMPORT_IN_PROGRESS">,
) {
  await tx
    .update(schema.emailDeliveryAttachments)
    .set({ importState: "failed", failureCode, fileId: null, updatedAt: new Date() })
    .where(eq(schema.emailDeliveryAttachments.id, attachmentId));
}
