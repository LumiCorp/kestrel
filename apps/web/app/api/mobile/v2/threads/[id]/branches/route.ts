import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveThreadEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileV2ThreadSnapshot } from "@/lib/mobile/v2/snapshot";
import { mobileOrganizationSetupRequiredTurnResponse } from "@/lib/organizations/turn-readiness";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";
import { resolveFreshForeignRuntimeAdmission } from "@/lib/turns/admission";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import {
  createMobileThreadBranchWithFirstTurn,
  DurableTurnError,
} from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z
  .object({
    id: routeIdSchema,
    anchorMessageId: routeIdSchema,
    message: z.object({
      id: routeIdSchema,
      parts: z.array(z.object({ type: z.literal("text"), text: z.string().min(1).max(50_000) }).strict()).length(1),
    }).strict(),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { id: parentThreadId } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) return mobileErrorResponse(new Error("Idempotency key required"), 400);
    const parent = await getThreadWithMessagesForUser(
      parentThreadId,
      session.user.id,
      organizationId,
    );
    if (!parent || parent.mode !== "chat") return mobileErrorResponse(new Error("Thread not found"), 404);
    const binding = parent.runtimeBinding;
    if (!binding || binding.runtimeId !== parent.runtimeId) {
      throw new DurableTurnError(
        "TURN_CONFLICT",
        "The parent Thread Runtime binding is unavailable.",
      );
    }
    if (
      binding.status === "degraded" ||
      binding.status === "released" ||
      binding.nativeSessionState === "degraded" ||
      binding.nativeSessionState === "released"
    ) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_DEGRADED",
        "This Thread is read-only. Create the offered recovery fork to continue.",
      );
    }
    const setupRequired =
      await mobileOrganizationSetupRequiredTurnResponse(organizationId);
    if (setupRequired) return setupRequired;
    const [projectContext, environment] = await Promise.all([
      resolveProjectRuntimeContext({ projectId: parent.projectId, organizationId, userId: session.user.id }),
      resolveThreadEnvironment({ organizationId, threadId: parent.id }),
    ]);
    if (!environment) return mobileErrorResponse(new Error("Environment unavailable"), 503);
    const requestedRuntimeId = parent.runtimeId;
    const requestedModelId = requestedRuntimeId === "kestrel"
      ? null
      : binding.selectedModelId;
    if (
      requestedRuntimeId !== "kestrel" &&
      (!requestedModelId || binding.environmentId !== environment.id)
    ) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_IMMUTABLE",
        "The parent Thread Runtime route is incomplete or has changed.",
      );
    }
    const runtimeAdmission = requestedRuntimeId === "kestrel"
      ? undefined
      : await resolveFreshForeignRuntimeAdmission({
          organizationId,
          userId: session.user.id,
          runtimeId: requestedRuntimeId,
          modelId: requestedModelId ?? undefined,
          projectId: parent.projectId,
        });
    if (
      runtimeAdmission &&
      (runtimeAdmission.environmentId !== environment.id ||
        runtimeAdmission.selectedModelId !== requestedModelId)
    ) {
      throw new DurableTurnError(
        "RUNTIME_BINDING_IMMUTABLE",
        "Runtime readiness no longer matches the parent Thread route.",
      );
    }
    const durable = await createMobileThreadBranchWithFirstTurn({
      threadId: body.id,
      parentThreadId,
      anchorMessageId: body.anchorMessageId,
      projectId: parent.projectId,
      organizationId,
      authorUserId: session.user.id,
      requestedEnvironmentId: environment.id,
      messageId: body.message.id,
      messageParts: body.message.parts,
      idempotencyKey,
      projectContextRevisionId: projectContext?.contextRevision.id ?? null,
      requestedModelId,
      requestedRuntimeId,
      runtimeAdmission,
      source: "mobile",
    });
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(durable.dispatchTurnId ?? durable.turn.id).catch(() => {});
    }
    const snapshot = await getMobileV2ThreadSnapshot({ threadId: body.id, organizationId, userId: session.user.id });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json(
      { snapshot, acceptedTurnId: durable.turn.id },
      { status: durable.created ? 202 : 200, headers: { location: `/api/mobile/v2/threads/${body.id}` } }
    );
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
