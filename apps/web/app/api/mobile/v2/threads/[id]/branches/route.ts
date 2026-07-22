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
import { createMobileThreadBranchWithFirstTurn } from "@/lib/turns/store";

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
    const parent = await getThreadForUser(parentThreadId, session.user.id, organizationId);
    if (!parent || parent.mode !== "chat") return mobileErrorResponse(new Error("Thread not found"), 404);
    const setupRequired =
      await mobileOrganizationSetupRequiredTurnResponse(organizationId);
    if (setupRequired) return setupRequired;
    const [projectContext, environment] = await Promise.all([
      resolveProjectRuntimeContext({ projectId: parent.projectId, organizationId, userId: session.user.id }),
      resolveThreadEnvironment({ organizationId, threadId: parent.id }),
    ]);
    if (!environment) return mobileErrorResponse(new Error("Environment unavailable"), 503);
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
      requestedModelId: null,
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
