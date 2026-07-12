import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  getThreadAccessForUser,
  updateThreadMessageFeedback,
} from "@/lib/threads/store";

const paramsSchema = z.object({
  id: routeIdSchema,
});

const bodySchema = z.object({
  feedback: z.enum(["positive", "negative"]).nullable(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());

    const [message] = await knowledgeDb
      .select({
        messageId: schema.threadMessages.id,
        role: schema.threadMessages.role,
        threadId: schema.threadMessages.threadId,
      })
      .from(schema.threadMessages)
      .where(eq(schema.threadMessages.id, params.id))
      .limit(1);
    const access = message
      ? await getThreadAccessForUser(
          message.threadId,
          session.user.id,
          organizationId,
          true
        )
      : null;

    if (!(message && access)) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    if (message.role !== "assistant") {
      return NextResponse.json(
        { error: "Feedback can only be added to assistant messages" },
        { status: 400 }
      );
    }

    const updated = await updateThreadMessageFeedback(
      params.id,
      message.threadId,
      body.feedback
    );

    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
