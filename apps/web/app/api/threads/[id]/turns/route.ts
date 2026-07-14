import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveThreadEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema, uiMessagePartSchema } from "@/lib/knowledge/validation";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { getThreadForUser } from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { createDurableThreadTurn } from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({
  message: z.object({
    id: routeIdSchema,
    parts: z.array(uiMessagePartSchema).min(1).max(200),
  }),
  model: z.string().min(1).max(200).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const thread = await getThreadForUser(id, session.user.id, organizationId);
    if (!thread || thread.mode !== "chat") {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const [projectContext, environment] = await Promise.all([
      resolveProjectRuntimeContext({
        projectId: thread.projectId,
        organizationId,
        userId: session.user.id,
      }),
      resolveThreadEnvironment({
        organizationId,
        threadId: thread.id,
      }),
    ]);
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
      idempotencyKey:
        request.headers.get("idempotency-key")?.trim() || body.message.id,
      projectContextRevisionId: projectContext?.contextRevision.id ?? null,
      requestedModelId: body.model ?? null,
      source: "web",
    });
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(durable.dispatchTurnId ?? durable.turn.id);
    }

    return NextResponse.json(
      {
        turn: {
          id: durable.turn.id,
          sequence: durable.turn.sequence,
          status: durable.turn.status,
        },
      },
      { status: durable.created ? 202 : 200 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
