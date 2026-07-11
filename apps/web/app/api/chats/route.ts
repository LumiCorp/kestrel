import type { UIMessage } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createChatForUser,
  deleteAllChatsForUser,
  listChatsForUser,
  saveKnowledgeMessages,
} from "@/lib/agent/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema, uiMessageSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({
  id: routeIdSchema,
  mode: z.enum(["chat", "admin"]).optional().default("chat"),
  message: uiMessageSchema as z.ZodType<UIMessage>,
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  ending_before: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const query = listQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    const pageSize = query.limit ?? 20;
    const chats = await listChatsForUser(session.user.id, organizationId, {
      limit: pageSize + 1,
      endingBefore: query.ending_before ?? null,
    });
    const hasMore = chats.length > pageSize;
    const page = hasMore ? chats.slice(0, pageSize) : chats;

    return NextResponse.json({
      chats: page.map((chat) => ({
        ...chat,
        title: chat.title || "New chat",
        visibility: chat.isPublic ? "public" : "private",
      })),
      hasMore,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const body = bodySchema.parse(await request.json());
    const user = session.user as { id: string; role?: string | null };

    if (body.mode === "admin" && user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const chat = await createChatForUser({
      id: body.id,
      userId: user.id,
      organizationId,
      mode: body.mode,
      title: "",
    });

    await saveKnowledgeMessages([
      {
        id: body.message.id,
        chatId: chat.id,
        role: "user",
        parts: body.message.parts,
      },
    ]);

    return NextResponse.json(chat, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE() {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    await deleteAllChatsForUser(session.user.id, organizationId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
