import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateKnowledgeMessageFeedback } from "@/lib/agent/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

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

    const rows = await knowledgeDb
      .select({
        messageId: schema.knowledgeMessages.id,
        role: schema.knowledgeMessages.role,
        chatId: schema.knowledgeChats.id,
      })
      .from(schema.knowledgeMessages)
      .innerJoin(
        schema.knowledgeChats,
        eq(schema.knowledgeMessages.chatId, schema.knowledgeChats.id)
      )
      .where(
        and(
          eq(schema.knowledgeMessages.id, params.id),
          eq(schema.knowledgeChats.userId, session.user.id),
          eq(schema.knowledgeChats.organizationId, organizationId)
        )
      );

    const message = rows[0];

    if (!message) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    if (message.role !== "assistant") {
      return NextResponse.json(
        { error: "Feedback can only be added to assistant messages" },
        { status: 400 }
      );
    }

    const updated = await updateKnowledgeMessageFeedback(
      params.id,
      message.chatId,
      body.feedback
    );

    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
