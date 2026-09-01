import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { attachmentIdsFromMessageParts } from "@/lib/attachments/store";
import { threadTurnBodySchema } from "@/lib/chat/thread-turn-request-contract";
import { applySubmittedToolApproval } from "@/lib/chat/tool-approval-response";
import { resolveThreadEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { organizationSetupRequiredTurnResponse } from "@/lib/organizations/turn-readiness";
import {
  archiveThreadForUser,
  assignStandaloneThreadToProject,
  createThreadForUser,
  getThreadWithMessagesForUser,
  permanentlyDeleteThreadForUser,
  updateThreadInteractionModeForUser,
  updateThreadTitleForUser,
} from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { KESTREL_ONE_INTERACTION_MODES } from "@/lib/turns/interaction-mode";
import { createDurableTurnReplayResponse } from "@/lib/turns/replay-response";
import { readThreadConversationSnapshotForUser } from "@/lib/turns/conversation-snapshot.server";
import {
  createDurableThreadTurn,
  createDurableApprovalResponseTurn,
  resolveDurableRuntimeInteraction,
} from "@/lib/turns/store";
import { convertToUIMessages } from "@/lib/utils";

const paramsSchema = z.object({ id: routeIdSchema });
const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    archived: z.boolean().optional(),
    projectId: routeIdSchema.optional(),
    disclosureAccepted: z.boolean().optional(),
    interactionMode: z.enum(KESTREL_ONE_INTERACTION_MODES).optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.archived !== undefined ||
      body.projectId !== undefined ||
      body.interactionMode !== undefined
  );

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const read = await readThreadConversationSnapshotForUser({
      threadId: params.id,
      userId: session.user.id,
      organizationId,
      includeArchived: true,
    });
    if (!read) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const { thread, snapshot } = read;
    return NextResponse.json({
      id: thread.id,
      title: thread.title || "New thread",
      createdByUserId: thread.createdByUserId,
      organizationId: thread.organizationId,
      projectId: thread.projectId,
      mode: thread.mode,
      interactionMode: thread.interactionMode,
      origin: thread.origin,
      emailReceipt: thread.emailReceipt
        ? {
            ...thread.emailReceipt,
            receivedAt: thread.emailReceipt.receivedAt.toISOString(),
          }
        : null,
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
      ...snapshot,
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
    const body = threadTurnBodySchema.parse(await request.json());
    const user = session.user as { id: string; role?: string | null };

    let thread = await getThreadWithMessagesForUser(
      params.id,
      user.id,
      organizationId
    );
    if (!(thread || body.message)) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    if (!thread) {
      const createdThread = await createThreadForUser({
        id: params.id,
        userId: user.id,
        organizationId,
        projectId: body.projectId,
        mode: "chat",
        workspaceMode: body.workspaceMode ?? "primary",
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

    if (body.interactionResponse) {
      const resumed = await resolveDurableRuntimeInteraction({
        threadId: thread.id,
        organizationId,
        userId: user.id,
        requestId: body.interactionResponse.requestId,
        eventType: body.interactionResponse.eventType,
        turnId: body.interactionResponse.turnId,
        message: body.interactionResponse.message,
        decision: body.interactionResponse.decision,
        reason: body.interactionResponse.reason,
        recoveryOptionId: body.interactionResponse.recoveryOptionId,
        messageId: body.interactionResponse.messageId ?? crypto.randomUUID(),
        source: "web",
      });
      if (resumed.shouldDispatch) {
        await enqueueDurableThreadTurn(resumed.turnId);
      }
      return createDurableTurnReplayResponse({
        turnId: resumed.turnId,
        signal: request.signal,
        afterSequence: resumed.replayAfterSequence,
      });
    }

    const persistedMessages = convertToUIMessages(thread.messages);
    const persistedMessageIds = new Set(
      persistedMessages.map((message) => message.id)
    );
    const newUserMessage =
      body.message && !persistedMessageIds.has(body.message.id)
        ? body.message
        : null;
    const approvalResponse = body.approvalResponse
      ? applySubmittedToolApproval({
          submittedApproval: body.approvalResponse,
          persistedMessages,
        })
      : null;
    if (!(newUserMessage || approvalResponse)) {
      return NextResponse.json(
        { error: "A new user message or approval response is required." },
        { status: 400 }
      );
    }

    if (newUserMessage) {
      const setupRequired =
        await organizationSetupRequiredTurnResponse(organizationId);
      if (setupRequired) return setupRequired;
    }

    const projectContext = await resolveProjectRuntimeContext({
      projectId: thread.projectId,
      organizationId,
      userId: user.id,
    });
    const environment = await resolveThreadEnvironment({
      organizationId,
      threadId: thread.id,
    });
    if (!environment) {
      throw new Error("No Environment is available for this Thread.");
    }
    const idempotencyKey = approvalResponse
      ? `approval:${approvalResponse.approvalId}`
      : request.headers.get("idempotency-key")?.trim() || newUserMessage?.id;
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "An idempotency key is required." },
        { status: 400 }
      );
    }
    let durable;
    if (approvalResponse) {
      durable = await createDurableApprovalResponseTurn({
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
        assistantMessage: {
          id: approvalResponse.assistantMessage.id,
          parts: approvalResponse.assistantMessage.parts,
        },
        idempotencyKey,
        requestedEnvironmentId: environment.id,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId: body.model ?? null,
        requestedInteractionMode: body.interactionMode,
        source: "web",
      });
    } else {
      if (!newUserMessage) {
        return NextResponse.json(
          { error: "A new user message or approval response is required." },
          { status: 400 }
        );
      }
      durable = await createDurableThreadTurn({
        threadId: thread.id,
        organizationId,
        authorUserId: user.id,
        messageId: newUserMessage.id,
        messageParts: newUserMessage.parts,
        attachmentIds: attachmentIdsFromMessageParts(newUserMessage.parts),
        idempotencyKey,
        requestedEnvironmentId: environment.id,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId: body.model ?? null,
        requestedInteractionMode: body.interactionMode,
        source: "web",
      });
    }
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(durable.dispatchTurnId ?? durable.turn.id);
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
    if (body.interactionMode !== undefined) {
      thread = await updateThreadInteractionModeForUser({
        id: params.id,
        userId: session.user.id,
        organizationId,
        interactionMode: body.interactionMode,
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
