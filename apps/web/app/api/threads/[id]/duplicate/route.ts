import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { assertRuntimeReleased } from "@/lib/runtimes/release-gate";
import { assertRuntimeAdmissionReady } from "@/lib/runtimes/descriptor-service";
import { and, desc, eq } from "drizzle-orm";
import {
  createThreadForUser,
  enqueueRuntimeBindingReleaseForThread,
  getThreadWithMessagesForUser,
  saveThreadMessages
} from "@/lib/threads/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({
  runtimeId: z.enum(["kestrel", "codex", "claude"]).optional(),
  failureCode: z.enum([
    "RUNTIME_NATIVE_SESSION_LOST",
    "RUNTIME_LIVE_WAIT_LOST",
  ]).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(
      request.headers.get("content-length") === "0"
        ? {}
        : await request.json().catch(() => ({})),
    );
    const source = await getThreadWithMessagesForUser(
      id,
      session.user.id,
      organizationId,
      true
    );
    if (!source?.access.canManage) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    let recoveryMessageIds = new Set<string>();
    let targetRuntimeId = body.runtimeId ?? source.runtimeId;
    if (body.failureCode) {
      const failedTurn = await knowledgeDb.query.threadTurns.findFirst({
        where: and(
          eq(schema.threadTurns.threadId, source.id),
          eq(schema.threadTurns.failureCode, body.failureCode),
        ),
        orderBy: [desc(schema.threadTurns.updatedAt)],
      });
      if (!failedTurn) {
        return NextResponse.json(
          { code: "RUNTIME_RECOVERY_UNAVAILABLE", error: "The requested Runtime recovery is not available." },
          { status: 409 },
        );
      }
      targetRuntimeId = body.failureCode === "RUNTIME_NATIVE_SESSION_LOST"
        ? "kestrel"
        : source.runtimeId;
      const interactions = await knowledgeDb.query.threadInteractions.findMany({
        where: eq(schema.threadInteractions.turnId, failedTurn.id),
      });
      recoveryMessageIds = new Set(
        interactions.flatMap((interaction) => {
          const response = interaction.responseEnvelope;
          const responseMessageId = response && typeof response === "object" &&
            "messageId" in response && typeof response.messageId === "string"
            ? response.messageId
            : undefined;
          return [interaction.assistantMessageId, responseMessageId].filter(
            (value): value is string => typeof value === "string",
          );
        }),
      );
      if (source.runtimeBindingId) {
        await knowledgeDb
          .update(schema.runtimeBindings)
          .set({ status: "degraded", nativeSessionState: "degraded", updatedAt: new Date() })
          .where(eq(schema.runtimeBindings.id, source.runtimeBindingId));
        await enqueueRuntimeBindingReleaseForThread({
          threadId: source.id,
          organizationId,
        });
      }
    }
    assertRuntimeReleased(targetRuntimeId);
    const latestTurn = targetRuntimeId === "kestrel"
      ? null
      : await knowledgeDb.query.threadTurns.findFirst({
          where: eq(schema.threadTurns.threadId, source.id),
          orderBy: [desc(schema.threadTurns.createdAt)],
        });
    const runtimeResolution = targetRuntimeId === "kestrel"
      ? undefined
      : await assertRuntimeAdmissionReady({
          organizationId,
          userId: session.user.id,
          runtimeId: targetRuntimeId,
          modelId: latestTurn?.requestedModelId ?? undefined,
          projectId: source.projectId,
        });
    const thread = await createThreadForUser({
      id: crypto.randomUUID(),
      userId: session.user.id,
      organizationId,
      projectId: source.projectId,
      mode: source.mode,
      interactionMode: source.interactionMode,
      runtimeId: targetRuntimeId,
      runtimeCapabilityDigest: runtimeResolution?.capabilityDigest,
      title: `${source.title || "New thread"} ${body.failureCode ? "recovery" : "copy"}`
    });
    if (!thread) throw new Error("Thread duplication failed.");

    const duplicatedAt = Date.now();
    await saveThreadMessages(
      source.messages.filter((message) => !recoveryMessageIds.has(message.id)).map((message, index) => ({
        id: crypto.randomUUID(),
        threadId: thread.id,
        role: message.role,
        authorUserId: message.authorUserId,
        projectContextRevisionId: message.projectContextRevisionId,
        parts: message.parts,
        searchText: message.searchText,
        source: message.source,
        createdAt: new Date(duplicatedAt + index)
      })),
      { meterUsage: false }
    );
    return NextResponse.json({ thread }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
