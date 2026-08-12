import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { decideAppOperationApprovalIfPresent } from "@/lib/apps/app-operation-approvals";
import { threadTurnBodySchema } from "@/lib/chat/thread-turn-request-contract";
import { applySubmittedToolApproval } from "@/lib/chat/tool-approval-response";
import {
  getDefaultOrganizationEnvironment,
  getOrganizationEnvironment,
  resolveThreadEnvironment,
} from "@/lib/environments/store";
import { decideGitHubActionApproval } from "@/lib/integrations/github-action-approvals";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { organizationSetupRequiredTurnResponse } from "@/lib/organizations/turn-readiness";
import {
  archiveThreadForUser,
  assignStandaloneThreadToProject,
  getThreadWithMessagesForUser,
  permanentlyDeleteThreadForUser,
  saveThreadMessages,
  updateThreadInteractionModeForUser,
  updateThreadTitleForUser,
} from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { KESTREL_ONE_INTERACTION_MODES } from "@/lib/turns/interaction-mode";
import { createDurableTurnReplayResponse } from "@/lib/turns/replay-response";
import { assertRuntimeReleased } from "@/lib/runtimes/release-gate";
import { assertRuntimeAdmissionReady } from "@/lib/runtimes/descriptor-service";
import {
  createWebThreadWithFirstTurn,
  getExistingDurableThreadTurnForAdmission,
  listDurableThreadQueueForUser,
  listThreadInteractionsForUser,
  resolveDurableRuntimeInteraction,
} from "@/lib/turns/store";
import {
  admitDurableThreadTurn,
  resolveFreshForeignRuntimeAdmission,
} from "@/lib/turns/admission";
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
    const thread = await getThreadWithMessagesForUser(
      params.id,
      session.user.id,
      organizationId,
      true
    );
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const [interactionLedger, durableQueue] = await Promise.all([
      listThreadInteractionsForUser({
        threadId: thread.id,
        organizationId,
        userId: session.user.id,
        includeArchived: true,
      }),
      listDurableThreadQueueForUser({
        threadId: thread.id,
        organizationId,
        userId: session.user.id,
        includeArchived: true,
      }),
    ]);
    return NextResponse.json({
      id: thread.id,
      title: thread.title || "New thread",
      createdByUserId: thread.createdByUserId,
      organizationId: thread.organizationId,
      projectId: thread.projectId,
      mode: thread.mode,
      interactionMode: thread.interactionMode,
      origin: thread.origin,
      runtimeId: thread.runtimeId,
      visibility: thread.isPublic ? "public" : "private",
      shareToken: thread.shareToken,
      archivedAt: thread.archivedAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      runtimeBinding: thread.runtimeBinding
        ? {
            status: thread.runtimeBinding.status,
            nativeSessionState: thread.runtimeBinding.nativeSessionState,
            selectedModelId: thread.runtimeBinding.selectedModelId,
          }
        : null,
      permissions: {
        canManage: thread.access.canManage,
        canPublish: thread.access.canPublish,
        projectRole: thread.access.projectRole,
      },
      messages: convertToUIMessages(thread.messages),
      interactions: interactionLedger,
      turns: durableQueue.turns,
      queue: durableQueue.queue,
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

    const thread = await getThreadWithMessagesForUser(
      params.id,
      user.id,
      organizationId
    );
    if (!(thread || body.message)) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const requestedRuntimeId = body.runtimeId ?? "kestrel";
    const submittedIdempotencyKey =
      request.headers.get("idempotency-key")?.trim() ||
      (body.approvalResponse
        ? `approval:${body.approvalResponse.approvalId}`
        : body.message?.id);
    if (thread && !body.interactionResponse && submittedIdempotencyKey) {
      const existing = await getExistingDurableThreadTurnForAdmission({
        threadId: thread.id,
        organizationId,
        authorUserId: user.id,
        idempotencyKey: submittedIdempotencyKey,
        requestedRuntimeId,
      });
      if (existing) {
        if (existing.shouldDispatch) {
          await enqueueDurableThreadTurn(
            existing.dispatchTurnId ?? existing.turn.id,
          );
        }
        return createDurableTurnReplayResponse({
          turnId: existing.turn.id,
          signal: request.signal,
        });
      }
    }
    try {
      assertRuntimeReleased(requestedRuntimeId);
    } catch (error) {
      return NextResponse.json(
        {
          code: "RUNTIME_RELEASE_DISABLED",
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }
    if (thread && requestedRuntimeId !== thread.runtimeId) {
      return NextResponse.json(
        {
          code: "RUNTIME_BINDING_IMMUTABLE",
          error: "The Runtime for an existing Thread cannot be changed.",
        },
        { status: 409 },
      );
    }
    if (
      thread?.runtimeBinding &&
      (thread.runtimeBinding.status === "degraded" ||
        thread.runtimeBinding.status === "released" ||
        thread.runtimeBinding.nativeSessionState === "degraded" ||
        thread.runtimeBinding.nativeSessionState === "released")
    ) {
      return NextResponse.json(
        {
          code: "RUNTIME_BINDING_DEGRADED",
          error: "This Thread is read-only. Create the offered recovery fork to continue.",
        },
        { status: 409 },
      );
    }
    const needsRuntimeAdmission = requestedRuntimeId !== "kestrel" &&
      (!thread || thread.messages.length === 0);
    const runtimeResolution = needsRuntimeAdmission
      ? await assertRuntimeAdmissionReady({
          organizationId,
          userId: user.id,
          runtimeId: requestedRuntimeId,
          modelId: thread?.runtimeBinding?.selectedModelId ?? body.model,
          projectId: thread?.projectId ?? body.projectId,
        })
      : undefined;
    if (!thread) {
      if (!body.message || body.approvalResponse || body.interactionResponse) {
        return NextResponse.json(
          { error: "A new Thread requires one ordinary user message." },
          { status: 400 },
        );
      }
      const setupRequired =
        await organizationSetupRequiredTurnResponse(organizationId);
      if (setupRequired) return setupRequired;
      const projectContext = await resolveProjectRuntimeContext({
        projectId: body.projectId ?? null,
        organizationId,
        userId: user.id,
      });
      const environment = projectContext
        ? await getOrganizationEnvironment({
            organizationId,
            environmentId: projectContext.project.environmentId,
          })
        : await getDefaultOrganizationEnvironment(organizationId);
      if (!environment) {
        throw new Error("No Environment is available for this Thread.");
      }
      const firstTurnResolution = requestedRuntimeId === "kestrel"
        ? undefined
        : await resolveFreshForeignRuntimeAdmission({
            organizationId,
            userId: user.id,
            runtimeId: requestedRuntimeId,
            modelId: body.model,
            projectId: body.projectId,
          });
      if (
        runtimeResolution &&
        firstTurnResolution &&
        (runtimeResolution.environmentId !== firstTurnResolution.environmentId ||
          runtimeResolution.selectedModelId !== firstTurnResolution.selectedModelId ||
          runtimeResolution.capabilityDigest !== firstTurnResolution.capabilityDigest)
      ) {
        throw new Error("Runtime readiness changed before Thread admission.");
      }
      if (
        firstTurnResolution &&
        firstTurnResolution.environmentId !== environment.id
      ) {
        throw new Error("Runtime readiness does not match the selected Environment.");
      }
      const idempotencyKey = submittedIdempotencyKey;
      if (!idempotencyKey) {
        return NextResponse.json(
          { error: "An idempotency key is required." },
          { status: 400 },
        );
      }
      const durable = await createWebThreadWithFirstTurn({
        threadId: params.id,
        projectId: body.projectId ?? null,
        organizationId,
        authorUserId: user.id,
        requestedEnvironmentId: environment.id,
        messageId: body.message.id,
        messageParts: body.message.parts,
        idempotencyKey,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId:
          firstTurnResolution?.selectedModelId ?? body.model ?? null,
        requestedRuntimeId,
        runtimeAdmission: firstTurnResolution,
        requestedInteractionMode: body.interactionMode,
        source: "web",
      });
      if (durable.shouldDispatch) {
        await enqueueDurableThreadTurn(
          durable.dispatchTurnId ?? durable.turn.id,
        );
      }
      return createDurableTurnReplayResponse({
        turnId: durable.turn.id,
        signal: request.signal,
      });
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
        ...(body.interactionResponse.message !== undefined
          ? { message: body.interactionResponse.message }
          : {}),
        answers: body.interactionResponse.answers,
        approved: body.interactionResponse.approved,
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
    if (approvalResponse) {
      const decidedAppOperation = await decideAppOperationApprovalIfPresent({
        organizationId,
        threadId: thread.id,
        userId: user.id,
        runtimeApprovalId: approvalResponse.approvalId,
        approved: approvalResponse.approved,
      });
      if (!decidedAppOperation) {
        await decideGitHubActionApproval({
          organizationId,
          threadId: thread.id,
          userId: user.id,
          runtimeApprovalId: approvalResponse.approvalId,
          approved: approvalResponse.approved,
        });
      }
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

    const idempotencyKey = submittedIdempotencyKey;
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: "An idempotency key is required." },
        { status: 400 }
      );
    }
    let durable;
    if (approvalResponse) {
      durable = await admitDurableThreadTurn({
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
        requestedEnvironmentId: environment.id,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId: body.model ?? null,
        requestedRuntimeId,
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
      durable = await admitDurableThreadTurn({
        threadId: thread.id,
        organizationId,
        authorUserId: user.id,
        messageId: newUserMessage.id,
        messageParts: newUserMessage.parts,
        idempotencyKey,
        requestedEnvironmentId: environment.id,
        projectContextRevisionId: projectContext?.contextRevision.id ?? null,
        requestedModelId: body.model ?? null,
        requestedRuntimeId,
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
