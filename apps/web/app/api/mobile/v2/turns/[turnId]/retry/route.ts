import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveThreadEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileV2ThreadSnapshot } from "@/lib/mobile/v2/snapshot";
import { mobileOrganizationSetupRequiredTurnResponse } from "@/lib/organizations/turn-readiness";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { getThreadForUser } from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import {
  createDurableThreadTurn,
  getDurableTurnRetrySourceForUser,
} from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });
const bodySchema = z.object({ messageId: routeIdSchema }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { turnId } = paramsSchema.parse(await context.params);
    const { messageId } = bodySchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey !== messageId) {
      return mobileErrorResponse(
        new Error("Idempotency key must match the retry message ID."),
        400
      );
    }

    const retrySource = await getDurableTurnRetrySourceForUser({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    if (!retrySource) {
      return mobileErrorResponse(new Error("Turn not found."), 404);
    }
    const thread = await getThreadForUser(
      retrySource.turn.threadId,
      session.user.id,
      organizationId
    );
    if (!thread || thread.mode !== "chat") {
      return mobileErrorResponse(new Error("Thread not found."), 404);
    }
    const setupRequired =
      await mobileOrganizationSetupRequiredTurnResponse(organizationId);
    if (setupRequired) return setupRequired;
    const [projectContext, environment] = await Promise.all([
      resolveProjectRuntimeContext({
        projectId: thread.projectId,
        organizationId,
        userId: session.user.id,
      }),
      resolveThreadEnvironment({ organizationId, threadId: thread.id }),
    ]);
    if (!environment) {
      return mobileErrorResponse(new Error("Environment unavailable."), 503);
    }

    const durable = await createDurableThreadTurn({
      threadId: thread.id,
      organizationId,
      authorUserId: session.user.id,
      requestedEnvironmentId: environment.id,
      messageId,
      messageParts: retrySource.messageParts,
      sourceMessageId: retrySource.sourceMessageId,
      idempotencyKey,
      projectContextRevisionId: projectContext?.contextRevision.id ?? null,
      requestedModelId: null,
      source: "mobile",
    });
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(
        durable.dispatchTurnId ?? durable.turn.id
      ).catch(() => {});
    }
    const snapshot = await getMobileV2ThreadSnapshot({
      threadId: thread.id,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json(
      { snapshot, acceptedTurnId: durable.turn.id },
      {
        status: durable.created ? 202 : 200,
        headers: {
          location: `/api/mobile/v2/turns/${durable.turn.id}`,
        },
      }
    );
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
