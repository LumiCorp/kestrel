import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveThreadEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { getThreadForUser } from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { createDurableThreadTurn } from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z
  .object({
    message: z.object({
      id: routeIdSchema,
      parts: z
        .array(
          z
            .object({
              type: z.literal("text"),
              text: z.string().min(1).max(50_000),
            })
            .strict()
        )
        .min(1)
        .max(1),
    }),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return mobileErrorResponse(new Error("Idempotency key required"), 400);
    }
    const thread = await getThreadForUser(id, session.user.id, organizationId);
    if (!thread || thread.mode !== "chat") {
      return mobileErrorResponse(new Error("Thread not found"), 404);
    }
    const projectContext = await resolveProjectRuntimeContext({
      projectId: thread.projectId,
      organizationId,
      userId: session.user.id,
    });
    const environment = await resolveThreadEnvironment({
      organizationId,
      threadId: thread.id,
    });
    if (!environment) {
      throw new Error("No Environment is available for this Thread.");
    }
    const durable = await createDurableThreadTurn({
      threadId: thread.id,
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
      await enqueueDurableThreadTurn(
        durable.dispatchTurnId ?? durable.turn.id
      ).catch(() => {});
    }
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
      threadId: id,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json(
      { snapshot, acceptedTurnId: durable.turn.id },
      {
        status: durable.created ? 202 : 200,
        headers: {
          location: `${request.nextUrl.pathname.startsWith("/api/mobile/v2/") ? "/api/mobile/v2" : "/api/mobile/v1"}/turns/${durable.turn.id}`,
        },
      }
    );
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
