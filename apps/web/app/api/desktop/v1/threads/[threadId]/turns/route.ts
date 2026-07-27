import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeDesktopUser } from "@/lib/desktop-account";
import { resolveThreadEnvironment } from "@/lib/environments/store";
import { organizationSetupRequiredTurnResponse } from "@/lib/organizations/turn-readiness";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { getThreadForUser } from "@/lib/threads/store";
import { KESTREL_ONE_INTERACTION_MODES } from "@/lib/turns/interaction-mode";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { createDurableThreadTurn } from "@/lib/turns/store";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { knowledgeDb } from "@/lib/knowledge/db";

const bodySchema = z.object({
  messageId: routeIdSchema,
  text: z.string().trim().min(1).max(100_000),
  interactionMode: z.enum(KESTREL_ONE_INTERACTION_MODES).default("chat"),
  model: z.string().trim().min(1).max(200).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  try {
    const { user } = await authorizeDesktopUser(request);
    const threadId = routeIdSchema.parse((await context.params).threadId);
    const body = bodySchema.parse(await request.json());
    const candidate = await knowledgeDb.query.threads.findFirst({
      where: (table, { eq }) => eq(table.id, threadId),
      columns: { organizationId: true },
    });
    if (!candidate) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const thread = await getThreadForUser(
      threadId,
      user.id,
      candidate.organizationId,
    );
    if (!thread || thread.mode !== "chat") {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const setupRequired = await organizationSetupRequiredTurnResponse(
      candidate.organizationId,
    );
    if (setupRequired) return setupRequired;
    const [projectContext, environment] = await Promise.all([
      resolveProjectRuntimeContext({
        projectId: thread.projectId,
        organizationId: candidate.organizationId,
        userId: user.id,
      }),
      resolveThreadEnvironment({
        organizationId: candidate.organizationId,
        threadId,
      }),
    ]);
    if (!environment) throw new Error("No Environment is available.");
    const durable = await createDurableThreadTurn({
      threadId,
      organizationId: candidate.organizationId,
      authorUserId: user.id,
      requestedEnvironmentId: environment.id,
      messageId: body.messageId,
      messageParts: [{ type: "text", text: body.text }],
      idempotencyKey:
        request.headers.get("idempotency-key")?.trim() || body.messageId,
      projectContextRevisionId: projectContext?.contextRevision.id ?? null,
      requestedModelId: body.model ?? null,
      requestedInteractionMode: body.interactionMode,
      source: "api",
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
      { status: durable.created ? 202 : 200 },
    );
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
}
