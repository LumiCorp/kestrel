import { createHash } from "node:crypto";
import {
  type EnvironmentExecutionTicket,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  AppOperationApprovalError,
  consumeAppOperationApproval,
} from "@/lib/apps/app-operation-approvals";
import { resolveEffectiveProjectAppAccess } from "@/lib/apps/project-service";
import { resolveOrganizationEmailConfig } from "@/lib/email/organization-config";
import {
  OrganizationEmailDeliveryError,
  sendOrganizationEmail,
} from "@/lib/email/organization-service";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

const emailAddress = z.string().trim().email().max(320);
const inputSchema = z
  .object({
    to: z.array(emailAddress).min(1).max(20),
    cc: z.array(emailAddress).max(20).optional(),
    bcc: z.array(emailAddress).max(20).optional(),
    subject: z.string().trim().min(1).max(998),
    text: z.string().min(1).max(100_000),
    html: z.string().min(1).max(200_000).optional(),
  })
  .superRefine((value, context) => {
    const count = value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0);
    if (count > 20) {
      context.addIssue({
        code: "custom",
        message: "Email supports at most 20 total recipients.",
      });
    }
  });

export async function POST(request: Request) {
  let ticket: EnvironmentExecutionTicket | null = null;
  let projectId: string | null = null;
  let recipientCount = 0;
  let recipientDomains: string[] = [];
  let subjectHash = "";
  let approvalId: string | null = null;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (!ticket.capabilities.includes("kestrel.tools.invoke")) {
      throw new EmailRuntimePolicyError("EMAIL_RUNTIME_CAPABILITY_DENIED", 403);
    }
    const raw = await request.json();
    const payload = asRecord(raw);
    if (!payload) throw new EmailRuntimePolicyError("EMAIL_INPUT_INVALID", 400);
    const input = inputSchema.parse(raw);
    const thread = await knowledgeDb.query.threads.findFirst({
      where: and(
        eq(schema.threads.id, ticket.threadId),
        eq(schema.threads.organizationId, ticket.organizationId)
      ),
      columns: { projectId: true },
    });
    if (!thread?.projectId) {
      throw new EmailRuntimePolicyError("EMAIL_PROJECT_REQUIRED", 403);
    }
    projectId = thread.projectId;
    const access = await resolveEffectiveProjectAppAccess({
      organizationId: ticket.organizationId,
      projectId,
      appKey: "email",
      userId: ticket.actorId,
    });
    const capability = access?.capabilities.find(
      (candidate) => candidate.key === "send"
    );
    if (!(access?.connectionId && capability?.approvalMode === "ask")) {
      throw new EmailRuntimePolicyError("EMAIL_APP_ACCESS_DENIED", 403);
    }
    const resource = await knowledgeDb.query.appConnectionResources.findFirst({
      where: and(
        eq(schema.appConnectionResources.connectionId, access.connectionId),
        eq(schema.appConnectionResources.resourceType, "sender"),
        eq(schema.appConnectionResources.enabled, true)
      ),
      columns: { id: true },
    });
    if (!resource) {
      throw new EmailRuntimePolicyError("EMAIL_SENDER_UNAVAILABLE", 409);
    }
    approvalId = readApprovalId(request.headers.get("x-kestrel-approval-id"));
    const consumed = await consumeAppOperationApproval({
      consumedExecutionId: ticket.runId,
      binding: {
        organizationId: ticket.organizationId,
        environmentId: ticket.environmentId,
        workspaceId: ticket.workspaceId,
        threadId: ticket.threadId,
        actorUserId: ticket.actorId,
        agentId: ticket.agentId,
        appKey: "email",
        capabilityKey: "send",
        connectionId: access.connectionId,
        resourceId: resource.id,
        resourceType: "sender",
        operationKey: "email.send",
        runtimeApprovalId: approvalId,
        payload,
      },
    });

    const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
    recipientCount = allRecipients.length;
    recipientDomains = [
      ...new Set(
        allRecipients.map((address) => address.slice(address.lastIndexOf("@") + 1).toLowerCase())
      ),
    ].sort();
    subjectHash = createHash("sha256").update(input.subject).digest("hex");
    const config = await resolveOrganizationEmailConfig(ticket.organizationId);
    const result = await sendOrganizationEmail({
      config,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html ? sanitizeEmailHtml(input.html) : undefined,
      idempotencyKey: `email-send-${consumed.id}`,
    });
    await knowledgeDb.insert(schema.organizationEmailDeliveries).values({
      organizationId: ticket.organizationId,
      projectId,
      threadId: ticket.threadId,
      actorUserId: ticket.actorId,
      approvalId: consumed.id,
      status: "accepted",
      providerMessageId: result.id,
      recipientCount,
      recipientDomains,
      subjectHash,
    });
    await logEmailEvent({
      ticket,
      projectId,
      approvalId: consumed.id,
      status: "accepted",
      providerMessageId: result.id,
      recipientCount,
      recipientDomains,
      subjectHash,
    });
    return NextResponse.json(
      { accepted: true, messageId: result.id, recipientCount },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    const failureCode = codeFor(error);
    if (ticket && projectId && recipientCount && subjectHash) {
      await knowledgeDb
        .insert(schema.organizationEmailDeliveries)
        .values({
          organizationId: ticket.organizationId,
          projectId,
          threadId: ticket.threadId,
          actorUserId: ticket.actorId,
          status: "failed",
          recipientCount,
          recipientDomains,
          subjectHash,
          failureCode,
        })
        .catch(() => {});
      await logEmailEvent({
        ticket,
        projectId,
        approvalId,
        status: "failed",
        recipientCount,
        recipientDomains,
        subjectHash,
        failureCode,
      }).catch(() => {});
    }
    if (error instanceof EmailRuntimePolicyError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status }
      );
    }
    if (error instanceof AppOperationApprovalError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.code.includes("BINDING") ? 403 : 409 }
      );
    }
    if (error instanceof OrganizationEmailDeliveryError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.code === "EMAIL_NOT_CONFIGURED" ? 409 : 502 }
      );
    }
    return errorResponse(error, ticket ? 400 : 401);
  }
}

class EmailRuntimePolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "EmailRuntimePolicyError";
  }
}

function sanitizeEmailHtml(value: string) {
  return sanitizeHtml(value, {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter(
      (tag) => !["script", "style", "iframe", "form"].includes(tag)
    ),
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["https", "mailto"],
    disallowedTagsMode: "discard",
  });
}

async function logEmailEvent(input: {
  ticket: EnvironmentExecutionTicket;
  projectId: string;
  approvalId: string | null;
  status: "accepted" | "failed";
  providerMessageId?: string;
  recipientCount: number;
  recipientDomains: string[];
  subjectHash: string;
  failureCode?: string;
}) {
  await logAdminEvent({
    organizationId: input.ticket.organizationId,
    actorUserId: input.ticket.actorId,
    category: "environment-tools",
    action: `email.send.${input.status}`,
    targetType: "environment",
    targetId: input.ticket.environmentId,
    message:
      input.status === "accepted"
        ? "Organization email was accepted for delivery."
        : "Organization email delivery failed.",
    metadata: {
      projectId: input.projectId,
      workspaceId: input.ticket.workspaceId,
      threadId: input.ticket.threadId,
      runId: input.ticket.runId,
      agentId: input.ticket.agentId,
      approvalId: input.approvalId,
      providerMessageId: input.providerMessageId,
      recipientCount: input.recipientCount,
      recipientDomains: input.recipientDomains,
      subjectHash: input.subjectHash,
      failureCode: input.failureCode,
      loggingMode: "metadata_only",
    },
  });
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match?.[1]) throw new Error("Environment execution ticket is required.");
  return match[1];
}

function readApprovalId(value: string | null) {
  const approvalId = value?.trim();
  if (!approvalId || approvalId.length > 500) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_REQUIRED");
  }
  return approvalId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function codeFor(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "EMAIL_DELIVERY_FAILED";
}
