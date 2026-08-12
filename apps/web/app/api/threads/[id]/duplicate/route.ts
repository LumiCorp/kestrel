import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { assertRuntimeReleased } from "@/lib/runtimes/release-gate";
import { assertRuntimeAdmissionReady } from "@/lib/runtimes/descriptor-service";
import {
  createThreadForUser,
  getThreadWithMessagesForUser,
  saveThreadMessages
} from "@/lib/threads/store";
import { createRuntimeRecoveryFork } from "@/lib/threads/runtime-recovery";

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

    if (body.failureCode) {
      const thread = await createRuntimeRecoveryFork({
        sourceThreadId: source.id,
        organizationId,
        userId: session.user.id,
        failureCode: body.failureCode,
      });
      return NextResponse.json({ thread }, { status: 201 });
    }

    const targetRuntimeId = body.runtimeId ?? source.runtimeId;
    assertRuntimeReleased(targetRuntimeId);
    const runtimeResolution = targetRuntimeId === "kestrel"
      ? undefined
      : await assertRuntimeAdmissionReady({
          organizationId,
          userId: session.user.id,
          runtimeId: targetRuntimeId,
          modelId: source.runtimeBinding?.selectedModelId ?? undefined,
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
      runtimeEnvironmentId: runtimeResolution?.environmentId,
      runtimeSelectedModelId: runtimeResolution?.selectedModelId,
      title: `${source.title || "New thread"} copy`
    });
    if (!thread) throw new Error("Thread duplication failed.");

    const duplicatedAt = Date.now();
    await saveThreadMessages(
      source.messages.map((message, index) => ({
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
