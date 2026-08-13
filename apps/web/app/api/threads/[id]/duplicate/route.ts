import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  createThreadForUser,
  getThreadWithMessagesForUser,
  saveThreadMessages
} from "@/lib/threads/store";
import { readThreadWorkspaceHead } from "@/lib/threads/workspace-head";

const paramsSchema = z.object({ id: routeIdSchema });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const source = await getThreadWithMessagesForUser(
      id,
      session.user.id,
      organizationId,
      true
    );
    if (!source?.access.canManage) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const workspaceBaseRef =
      source.workspaceMode === "isolated"
        ? await readThreadWorkspaceHead({
            organizationId,
            threadId: source.id,
            actorUserId: session.user.id,
            unprovisionedBaseRef: source.workspaceBaseRef,
          })
        : null;
    const thread = await createThreadForUser({
      id: crypto.randomUUID(),
      userId: session.user.id,
      organizationId,
      projectId: source.projectId,
      mode: source.mode,
      workspaceMode: source.workspaceMode,
      workspaceBaseRef,
      parentThreadId: source.id,
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
