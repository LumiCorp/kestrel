import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  AppOperationApprovalError,
  consumeAppOperationApproval,
} from "@/lib/apps/app-operation-approvals";
import { knowledgeDb } from "@/lib/knowledge/db";
import {
  getGmailAttachmentBytes,
  getGmailMessage,
  getGmailThread,
  GmailProviderError,
  searchGmailMessages,
} from "@/lib/integrations/gmail-api";
import {
  createGmailMutationRawMessage,
  GmailMutationProviderError,
  sendGmailMutation,
} from "../../../../../../../src/apps/gmailMutation";
import {
  capabilityForGmailOperation,
  gmailRuntimeInputSchema,
  hasGmailCapabilityScopes,
} from "@/lib/integrations/gmail-contract";
import {
  admitGmailExecutionRoute,
  authorizeGmailCapability,
  GmailPolicyError,
} from "@/lib/integrations/gmail-policy";
import {
  discardUnreferencedFile,
  initializeThreadFile,
  uploadThreadFile,
} from "@/lib/files/service";
import {
  materializePreparedGmailAttachments,
  parsePreparedGmailMutationApproval,
} from "@/lib/integrations/gmail-mutation-preparation";
import {
  HostedPersonalOAuthError,
  markHostedPersonalAuthorizationDegraded,
  resolveHostedPersonalProviderToken,
} from "@/lib/integrations/hosted-personal-oauth";
import { errorResponse } from "@/lib/knowledge/http";
import {
  createGmailPageCursor,
  readGmailPageCursor,
} from "../../../../../../../src/apps/gmailPaging.js";

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let connectionId: string | undefined;
  let accountId: string | undefined;
  let mutationOperation: "gmail.messages.send" | "gmail.messages.reply" | undefined;
  let mutationApprovalId: string | null = null;
  let mutationAudit:
    | { recipientCount: number; attachments: Array<{ fileId: string; sha256: string }> }
    | undefined;
  const startedAt = Date.now();
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (!ticket.capabilities.includes("kestrel.tools.invoke")) {
      throw new GmailPolicyError("GMAIL_ROUTE_CAPABILITY_DENIED");
    }
    const input = gmailRuntimeInputSchema.parse(await request.json());
    const capability = capabilityForGmailOperation(input.operation);
    const policy = await authorizeGmailCapability({ ticket, capability });
    connectionId = policy.connection.id;
    accountId = policy.connection.externalAccountId ?? undefined;
    await admitGmailExecutionRoute({
      ticket: ticket!,
      projectAuthorized: true,
      gmailReadonlyGranted: hasGmailCapabilityScopes({
        grantedScopes: policy.connection.scopes,
        capability,
      }),
    });
    if (!policy.connection.externalAccountId) {
      throw new GmailPolicyError("GMAIL_ACCOUNT_DENIED");
    }
    const actorUserId = ticket.actorId;
    const organizationId = ticket.organizationId;
    const threadId = ticket.threadId;
    const getRequestAccessToken = () => getAccessToken({
      connectionId: policy.connection.id,
      organizationId,
      projectId: policy.projectId,
      userId: actorUserId,
      operation: input.operation,
      ticket: ticket!,
    });
    let result: unknown;
    let cursorState: "none" | "consumed" | "issued" = "none";
    const isWrite =
      input.operation === "gmail.messages.send" ||
      input.operation === "gmail.messages.reply";
    mutationOperation = isWrite ? input.operation : undefined;
    const runtimeApprovalId = readApprovalId(
      request.headers.get("x-kestrel-approval-id"),
    );
    mutationApprovalId = runtimeApprovalId;
    if (input.operation === "gmail.messages.search") {
      const context = {
        accountId: policy.connection.externalAccountId,
        projectId: policy.projectId,
        threadId: ticket.threadId,
        operation: input.operation,
        query: input.query,
        maxResults: input.maxResults,
      } as const;
      const pageToken = input.cursor === undefined ? undefined : readGmailPageCursor({
        secret: gmailCursorSecret(), cursor: input.cursor, context,
      }).pageToken;
      if (pageToken !== undefined) cursorState = "consumed";
      const page = await searchGmailMessages({
        accessToken: await getRequestAccessToken(), query: input.query, maxResults: input.maxResults,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const nextCursor = page.nextPageToken === null ? null : createGmailPageCursor({
        secret: gmailCursorSecret(), context, pageToken: page.nextPageToken,
      });
      if (nextCursor !== null) cursorState = "issued";
      result = { messages: page.messages, nextCursor };
    } else if (input.operation === "gmail.messages.get") {
      result = await getGmailMessage({ accessToken: await getRequestAccessToken(), messageId: input.messageId });
    } else if (input.operation === "gmail.threads.get") {
      result = await getGmailThread({ accessToken: await getRequestAccessToken(), threadId: input.threadId });
    } else if (input.operation === "gmail.attachments.import") {
      const accessToken = await getRequestAccessToken();
      const message = await getGmailMessage({ accessToken, messageId: input.messageId });
      const attachment = message.attachments.find(
        (candidate) => candidate.attachmentId === input.attachmentId,
      );
      if (!attachment) throw new GmailPolicyError("GMAIL_ATTACHMENT_DENIED", 404);
      let fileId: string | undefined;
      try {
        const bytes = await getGmailAttachmentBytes({
          accessToken, messageId: input.messageId, attachmentId: input.attachmentId,
        });
        if (bytes.byteLength !== attachment.sizeBytes) {
          throw new GmailPolicyError("GMAIL_ATTACHMENT_INTEGRITY_FAILED", 502);
        }
        const initialized = await initializeThreadFile({
          threadId: ticket.threadId,
          organizationId: ticket.organizationId,
          userId: ticket.actorId,
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
          ...(attachment.mediaType === null ? {} : { declaredMediaType: attachment.mediaType }),
        });
        fileId = initialized.id;
        const uploaded = await uploadThreadFile({
          fileId,
          threadId: ticket.threadId,
          organizationId: ticket.organizationId,
          userId: ticket.actorId,
          body: bufferStream(bytes),
          contentLength: bytes.byteLength,
        });
        result = {
          fileId: uploaded.id,
          filename: uploaded.filename,
          sizeBytes: uploaded.sizeBytes,
          status: uploaded.lifecycleState,
        };
      } catch (error) {
        if (fileId) await discardUnreferencedFile(fileId, { removeScopeGrants: true }).catch(() => {});
        throw error;
      }
    } else if (isWrite) {
      if (runtimeApprovalId === null) {
        throw new GmailPolicyError("GMAIL_APPROVAL_REQUIRED", 409);
      }
      const resource = await knowledgeDb.query.appConnectionResources.findFirst({
        where: (table, { and, eq }) => and(
          eq(table.connectionId, policy.connection.id),
          eq(table.resourceType, "account"),
          eq(table.externalId, "primary"),
          eq(table.enabled, true),
        ),
        columns: { id: true },
      });
      if (!resource) {
        throw new GmailPolicyError("GMAIL_ACCOUNT_DENIED", 409);
      }
      const recordedApproval = await knowledgeDb.query.appOperationApprovals.findFirst({
        where: (table, { and, eq }) => and(
          eq(table.organizationId, organizationId),
          eq(table.threadId, threadId),
          eq(table.runtimeApprovalId, runtimeApprovalId),
        ),
        columns: { payload: true },
      });
      const prepared = parsePreparedGmailMutationApproval(recordedApproval?.payload);
      if (prepared.approvalPayload.operation !== input.operation) {
        throw new GmailPolicyError("GMAIL_APPROVAL_INVALID", 409);
      }
      await consumeAppOperationApproval({
        consumedExecutionId: ticket.runId,
        binding: {
          organizationId: ticket.organizationId,
          environmentId: ticket.environmentId,
          workspaceId: ticket.workspaceId,
          threadId: ticket.threadId,
          actorUserId: ticket.actorId,
          agentId: ticket.agentId,
          appKey: "google_workspace",
          capabilityKey: capability,
          connectionId: policy.connection.id,
          resourceId: resource.id,
          resourceType: "account",
          operationKey: input.operation,
          runtimeApprovalId,
          payload: prepared.approvalPayload,
        },
      });
      // Set durable content-free identity before credential recovery so a
      // post-approval authentication failure is audited like any other
      // attempted mutation without retaining the approved message payload.
      mutationAudit = {
        recipientCount: prepared.envelope.to.length + prepared.envelope.cc.length,
        attachments: prepared.attachments.map((attachment) => ({
          fileId: attachment.fileId,
          sha256: attachment.sha256,
        })),
      };
      const accessToken = await getRequestAccessToken();
      const attachments = await materializePreparedGmailAttachments({
        attachments: prepared.attachments,
        threadId: ticket.threadId,
        organizationId: ticket.organizationId,
        userId: ticket.actorId,
      });
      result = await sendGmailMutation({
        accessToken,
        raw: createGmailMutationRawMessage({
          ...prepared.envelope,
          attachments,
        }),
        ...(prepared.envelope.threadId === undefined
          ? {}
          : { threadId: prepared.envelope.threadId }),
      });
    } else {
      throw new GmailPolicyError("GMAIL_OPERATION_DENIED", 400);
    }
    await logAdminEvent({
      organizationId: ticket.organizationId,
      actorUserId: ticket.actorId,
      category: "environment-tools",
      action: input.operation,
      targetType: "environment",
      targetId: ticket.environmentId,
      message: `Executed ${input.operation} through Gmail.`,
      metadata: {
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        runId: ticket.runId,
        agentId: ticket.agentId,
        capability,
        loggingMode: policy.loggingMode,
        accountId: policy.connection.externalAccountId,
        cursorState,
        ...(input.operation === "gmail.messages.search"
          ? { resultCount: (result as { messages: unknown[] }).messages.length }
          : input.operation === "gmail.messages.get"
            ? { providerMessageId: input.messageId }
            : input.operation === "gmail.threads.get"
              ? { providerThreadId: input.threadId }
              : input.operation === "gmail.attachments.import"
                ? { providerMessageId: input.messageId, providerAttachmentId: input.attachmentId, importedBytes: (result as { sizeBytes: number }).sizeBytes }
                : {
                    mutationOutcome: "confirmed",
                    runtimeApprovalId,
                    providerMessageId: (result as { id: string }).id,
                    providerThreadId: (result as { threadId: string }).threadId,
                    providerTimestamp: (result as { createdAt: string | null }).createdAt,
                    recipientCount: mutationAudit?.recipientCount ?? 0,
                    attachments: mutationAudit?.attachments ?? [],
                    durationMs: Date.now() - startedAt,
                  }),
      },
    });
    return NextResponse.json({ operation: input.operation, result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GmailPolicyError) {
      return NextResponse.json({ error: { code: error.code } }, { status: error.status });
    }
    if (error instanceof AppOperationApprovalError) {
      return NextResponse.json({ error: { code: error.code } }, { status: 409 });
    }
    if (error instanceof GmailProviderError || error instanceof GmailMutationProviderError) {
      if (ticket && connectionId && accountId && mutationOperation && mutationAudit) {
        await logAdminEvent({
          organizationId: ticket.organizationId,
          actorUserId: ticket.actorId,
          category: "environment-tools",
          action: mutationOperation,
          targetType: "environment",
          targetId: ticket.environmentId,
          message: `Gmail ${mutationOperation} returned ${error.code}.`,
          metadata: {
            workspaceId: ticket.workspaceId,
            threadId: ticket.threadId,
            runId: ticket.runId,
            agentId: ticket.agentId,
            accountId,
            connectionId,
            runtimeApprovalId: mutationApprovalId,
            mutationOutcome: error.outcomeUnknown ? "outcome_unknown" : "rejected",
            providerStatus: error.status,
            providerErrorCode: error.code,
            recipientCount: mutationAudit.recipientCount,
            attachments: mutationAudit.attachments,
            durationMs: Date.now() - startedAt,
          },
        }).catch(() => {});
      }
      if (error.reconnectRequired && connectionId) {
        await markHostedPersonalAuthorizationDegraded({ connectionId, code: error.code }).catch(() => {});
      }
      return NextResponse.json({ error: { code: error.code, reconnectRequired: error.reconnectRequired } }, { status: error.status });
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

function gmailCursorSecret() {
  const secret = process.env.KESTREL_GMAIL_CURSOR_SECRET;
  if (!secret || secret.length < 32) throw new GmailPolicyError("GMAIL_CURSOR_UNAVAILABLE", 503);
  return secret;
}

async function getAccessToken(input: {
  connectionId: string;
  organizationId: string;
  projectId: string;
  userId: string;
  operation: Parameters<typeof resolveHostedPersonalProviderToken>[0]["operation"];
  ticket: EnvironmentExecutionTicket;
}) {
  try {
    const token = await resolveHostedPersonalProviderToken({
      provider: "google_workspace",
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      operation: input.operation,
      gmailExecution: input.ticket,
    });
    return token.accessToken;
  } catch (error) {
    if (error instanceof HostedPersonalOAuthError && error.code !== "OAUTH_RECONNECT_REQUIRED") {
      throw new GmailPolicyError(error.code);
    }
    throw new GmailProviderError({ code: "GMAIL_RECONNECT_REQUIRED", status: 401, reconnectRequired: true });
  }
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}

function readApprovalId(value: string | null) {
  const approvalId = value?.trim();
  return approvalId && approvalId.length <= 200 ? approvalId : null;
}

function bufferStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}
