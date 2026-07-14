import type { UIMessage } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createKestrelOneAgentResponse } from "@/lib/agent/kestrel-runtime";
import { prepareKestrelRuntimeMessagesForPersistence } from "@/lib/agent/kestrel-runtime-persistence";
import { generateTitleFromUserMessage } from "@/lib/chat/actions";
import {
  findNewToolApprovalResponse,
  hasToolApprovalResponse,
} from "@/lib/chat/tool-approval-response";
import { decideGitHubActionApproval } from "@/lib/integrations/github-action-approvals";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema, uiMessageSchema } from "@/lib/knowledge/validation";
import {
  issueProjectContextGrant,
  revokeProjectContextGrant,
} from "@/lib/projects/context-grants";
import {
  formatProjectSystemContext,
  resolveProjectRuntimeContext,
} from "@/lib/projects/runtime-context";
import {
  archiveThreadForUser,
  assignStandaloneThreadToProject,
  createThreadForUser,
  getThreadWithMessagesForUser,
  permanentlyDeleteThreadForUser,
  saveThreadMessages,
  updateThreadTitleForUser,
} from "@/lib/threads/store";
import {
  convertToUIMessages,
  isPersistableAssistantMessage,
} from "@/lib/utils";

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
    const issuedGrant = projectContext
      ? await issueProjectContextGrant({
          organizationId,
          projectId: projectContext.project.id,
          threadId: thread.id,
          actorUserId: user.id,
          contextRevisionId: projectContext.contextRevision.id,
          contextRevision: projectContext.contextRevision.revision,
        })
      : null;

    const isNewUserMessage =
      submittedUserMessage !== undefined &&
      !thread.messages.some(
        (message) => message.id === submittedUserMessage.id
      );
    if (isNewUserMessage && submittedUserMessage) {
      await saveThreadMessages([
        {
          id: submittedUserMessage.id,
          threadId: thread.id,
          role: "user",
          authorUserId: user.id,
          projectContextRevisionId: projectContext?.contextRevision.id ?? null,
          parts: submittedUserMessage.parts,
        },
      ]);
    }
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

    const canonicalThread = await getThreadWithMessagesForUser(
      thread.id,
      user.id,
      organizationId
    );
    if (!canonicalThread) {
      throw new Error("Thread became unavailable.");
    }
    const canonicalMessages = convertToUIMessages(canonicalThread.messages);
    const hasPriorUserMessage = submittedUserMessage
      ? canonicalThread.messages.some(
          (message) =>
            message.role === "user" && message.id !== submittedUserMessage.id
        )
      : true;

    try {
      return await createKestrelOneAgentResponse({
        request,
        session,
        organizationId,
        threadId: canonicalThread.id,
        messages: canonicalMessages,
        modelId: body.model,
        approvalDecision: approvalResponse
          ? {
              approvalId: approvalResponse.approvalId,
              approved: approvalResponse.approved,
              reason: approvalResponse.reason,
            }
          : undefined,
        projectContext:
          projectContext && issuedGrant
            ? {
                projectId: projectContext.project.id,
                contextRevisionId: projectContext.contextRevision.id,
                contextRevision: projectContext.contextRevision.revision,
                grantId: issuedGrant.grantId,
                systemContext: formatProjectSystemContext({
                  projectName: projectContext.contextRevision.projectName,
                  instructions: projectContext.contextRevision.instructions,
                  revision: projectContext.contextRevision.revision,
                }),
              }
            : undefined,
        transientTitle:
          approvalResponse ||
          canonicalThread.title ||
          hasPriorUserMessage ||
          !submittedUserMessage
            ? null
            : generateTitleFromUserMessage({
                message: submittedUserMessage,
                modelId: body.model,
              }).catch(() => null),
        onFinishPersist: async (messages, meta) => {
          try {
            const messagesForPersistence =
              prepareKestrelRuntimeMessagesForPersistence(messages, meta);
            const assistantMessages = messagesForPersistence.filter(
              (message) =>
                message.role === "assistant" &&
                isPersistableAssistantMessage(message)
            );
            await saveThreadMessages(
              Array.from(
                new Map(
                  assistantMessages.map((message) => [
                    message.id,
                    {
                      id: message.id,
                      threadId: canonicalThread.id,
                      role: "assistant" as const,
                      authorUserId: null,
                      projectContextRevisionId:
                        projectContext?.contextRevision.id ?? null,
                      parts: message.parts,
                      model: meta.model,
                    },
                  ])
                ).values()
              )
            );
            if (meta.title) {
              await updateThreadTitleForUser({
                id: canonicalThread.id,
                userId: user.id,
                organizationId,
                title: meta.title,
              });
            }
          } finally {
            if (issuedGrant) {
              await revokeProjectContextGrant(issuedGrant.grantId);
            }
          }
        },
      });
    } catch (error) {
      if (issuedGrant) {
        await revokeProjectContextGrant(issuedGrant.grantId);
      }
      throw error;
    }
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
