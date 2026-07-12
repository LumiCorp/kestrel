import { readRequestCorrelation } from "@kestrel-agents/next";
import { KestrelClient } from "@kestrel-agents/sdk/runner";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeKestrelReconnectStreamToUi } from "@/lib/agent/kestrel-reconnect-stream";
import {
  createKestrelOneRequestContext,
  type KestrelOneRequestContext,
} from "@/lib/agent/kestrel-runtime-core";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";

const paramsSchema = z.object({
  id: routeIdSchema,
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const user = session.user as { id: string; role?: string | null };
    const thread = await getThreadWithMessagesForUser(
      params.id,
      user.id,
      organizationId
    );

    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    if (thread.mode === "admin" && user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const client = new KestrelClient({
      baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL,
      authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
    });
    const runnerContext = createKestrelOneRequestContext({
      session,
      organizationId,
      correlation: readRequestCorrelation(request),
    }) as unknown as KestrelOneRequestContext;
    const assistantMessageId = crypto.randomUUID();
    const textPartId = crypto.randomUUID();
    const reasoningPartId = crypto.randomUUID();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        try {
          const runnerStream = client.subscribe(
            { sessionId: params.id },
            runnerContext,
            { signal: request.signal }
          );

          await writeKestrelReconnectStreamToUi({
            writer,
            events: runnerStream,
            assistantMessageId,
            textPartId,
            reasoningPartId,
          });
        } finally {
          await client.close();
        }
      },
      onError: (error) =>
        error instanceof Error
          ? error.message
          : "The Kestrel runtime stream failed.",
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    return errorResponse(error, 400);
  }
}
