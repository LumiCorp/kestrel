import type { UIMessage } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  findNewToolApprovalResponse,
  hasToolApprovalResponse,
} from "@/lib/chat/tool-approval-response";
import { decideGitHubActionApproval } from "@/lib/integrations/github-action-approvals";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema, uiMessageSchema } from "@/lib/knowledge/validation";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import {
  archiveThreadForUser,
  assignStandaloneThreadToProject,
  createThreadForUser,
  getThreadWithMessagesForUser,
  permanentlyDeleteThreadForUser,
  saveThreadMessages,
  updateThreadTitleForUser,
} from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { createDurableTurnReplayResponse } from "@/lib/turns/replay-response";
import { createDurableThreadTurn } from "@/lib/turns/store";
import { convertToUIMessages } from "@/lib/utils";

const paramsSchema = z.object({ id: routeIdSchema });
const turnBodySchema = z.object({
  model: z.string().min(1).max(200).optional(),
  projectId: routeIdSchema.nullable().optional(),
  messages: z
    .array(uiMessageSchema as z.ZodType<UIMessage>)
    .min(1)
    .max(200),
});
const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    archived: z.boolean().optional(),
    projectId: routeIdSchema.optional(),
    disclosureAccepted: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.archived !== undefined ||
      body.projectId !== undefined
  );

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const thread = await getThreadWithMessagesForUser(
      params.id,
      session.user.id,
      organizationId,
      true
    );
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return NextResponse.json({
      id: thread.id,
      title: thread.title || "New thread",
      createdByUserId: thread.createdByUserId,
      organizationId: thread.organizationId,
      projectId: thread.projectId,
      mode: thread.mode,
      origin: thread.origin,
      visibility: thread.isPublic ? "public" : "private",
      shareToken: thread.shareToken,
      archivedAt: thread.archivedAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      permissions: {
        canManage: thread.access.canManage,
        canPublish: thread.access.canPublish,
        projectRole: thread.access.projectRole,
      },
      messages: convertToUIMessages(thread.messages),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = turnBodySchema.parse(await request.json());
    const user = session.user as { id: string; role?: string | null };
    const submittedUserMessage = [...body.messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!(submittedUserMessage || hasToolApprovalResponse(body.messages))) {
      return NextResponse.json(
        { error: "A user message is required." },
        { status: 400 }
      );
    }

    let thread = await getThreadWithMessagesForUser(
      params.id,
      user.id,
      organizationId
    );
    if (!thread) {
      const createdThread = await createThreadForUser({
        id: params.id,
        userId: user.id,
        organizationId,
        projectId: body.projectId,
        mode: "chat",
        title: "",
      });
      if (!createdThread) {
        throw new Error("Thread creation failed.");
      }
      thread = await getThreadWithMessagesForUser(
        createdThread.id,
        user.id,
        organizationId
      );
    }
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    if (thread.mode === "admin" && user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const persistedMessages = convertToUIMessages(thread.messages);
    const approvalResponse = findNewToolApprovalResponse({
      submittedMessages: body.messages,
      persistedMessages,
    });
    if (!(submittedUserMessage || approvalResponse)) {
      return NextResponse.json(
        { error: "A new user message or approval response is required." },
        { status: 400 }
      );
    }

    const projectContext = await resolveProjectRuntimeContext({
      projectId: thread.projectId,
      organizationId,
      userId: user.id,
    });
    if (approvalResponse) {
      await decideGitHubActionApproval({
        organizationId,
        threadId: thread.id,
        userId: user.id,
        runtimeApprovalId: approvalResponse.approvalId,
        approved: approvalResponse.approved,
      });
      await saveThreadMessages([
        {
          id: approvalResponse.assistantMessage.id,
          threadId: thread.id,
          role: "assistant",
          authorUserId: null,
          projectContextRevisionId: projectContext?.contextRevision.id ?? null,
          parts: approvalResponse.assistantMessage.parts,
        },
      ]);
    }

    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() ||
      (approvalResponse
        ? `approval:${approvalResponse.approvalId}`
        : submittedUserMessage?.id);
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "An idempotency key is required." },
        { status: 400 }
      );
    }
    let durable;
    if (approvalResponse) {
      durable = await createDurableThreadTurn({
        threadId: thread.id,
        organizationId,
        authorUserId: user.id,
        messageId: null,
        approvalDecision: {
          approvalId: approvalResponse.approvalId,
          approved: approvalResponse.approved,
          ...(approvalResponse.reason
            ? { reason: approvalResponse.reason }
            : {}),
        },
        idempotencyKey,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId: body.model ?? null,
        source: "web",
      });
    } else {
      if (!submittedUserMessage) {
        return NextResponse.json(
          { error: "A new user message or approval response is required." },
          { status: 400 }
        );
      }
      durable = await createDurableThreadTurn({
        threadId: thread.id,
        organizationId,
        authorUserId: user.id,
        messageId: submittedUserMessage.id,
        messageParts: submittedUserMessage.parts,
        idempotencyKey,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId: body.model ?? null,
        source: "web",
      });
    }
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(durable.turn.id);
    }
    return createDurableTurnReplayResponse({
      turnId: durable.turn.id,
      signal: request.signal,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = patchBodySchema.parse(await request.json());
    let thread = null;
    if (body.title !== undefined) {
      thread = await updateThreadTitleForUser({
        id: params.id,
        userId: session.user.id,
        organizationId,
        title: body.title,
      });
    }
    if (body.archived !== undefined) {
      thread = await archiveThreadForUser({
        id: params.id,
        userId: session.user.id,
        organizationId,
        archived: body.archived,
      });
    }
    if (body.projectId !== undefined) {
      thread = await assignStandaloneThreadToProject({
        id: params.id,
        projectId: body.projectId,
        userId: session.user.id,
        organizationId,
        disclosureAccepted: body.disclosureAccepted === true,
      });
    }
    return thread
      ? NextResponse.json(thread)
      : NextResponse.json({ error: "Thread not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const deleted = await permanentlyDeleteThreadForUser({
      id: params.id,
      userId: session.user.id,
      organizationId,
    });
    return deleted
      ? NextResponse.json({ success: true })
      : NextResponse.json(
          { error: "Archived thread not found or deletion is not allowed" },
          { status: 404 }
        );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
