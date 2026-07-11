import type { UIMessage } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createKestrelOneAgentResponse } from "@/lib/agent/kestrel-runtime";
import { prepareKestrelRuntimeMessagesForPersistence } from "@/lib/agent/kestrel-runtime-persistence";
import {
  createChatForUser,
  deleteChatForUser,
  getChatWithMessagesForUser,
  saveKnowledgeMessages,
  updateChatTitleForUser,
} from "@/lib/agent/store";
import { generateTitleFromUserMessage } from "@/lib/chat/actions";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema, uiMessageSchema } from "@/lib/knowledge/validation";
import {
  convertToUIMessages,
  isPersistableAssistantMessage,
} from "@/lib/utils";

const paramsSchema = z.object({
  id: routeIdSchema,
});

const bodySchema = z.object({
  model: z.string().min(1).max(200).optional(),
  messages: z
    .array(uiMessageSchema as z.ZodType<UIMessage>)
    .min(1)
    .max(200),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const chat = await getChatWithMessagesForUser(
      params.id,
      session.user.id,
      organizationId
    );

    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...chat,
      title: chat.title || "New chat",
      visibility: chat.isPublic ? "public" : "private",
      messages: convertToUIMessages(chat.messages),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const user = session.user as { id: string; role?: string | null };

    let chat = await getChatWithMessagesForUser(
      params.id,
      user.id,
      organizationId
    );

    const lastMessage = body.messages.at(-1);
    const isFirstUserMessage =
      lastMessage?.role === "user" &&
      !body.messages.slice(0, -1).some((message) => message.role === "user");

    if (!chat && isFirstUserMessage && lastMessage) {
      const createdChat = await createChatForUser({
        id: params.id,
        userId: user.id,
        organizationId,
        mode: "chat",
        title: "",
      });

      await saveKnowledgeMessages([
        {
          id: lastMessage.id,
          chatId: createdChat.id,
          role: "user",
          parts: lastMessage.parts,
        },
      ]);

      chat = {
        ...createdChat,
        messages: [
          {
            id: lastMessage.id,
            chatId: createdChat.id,
            role: "user",
            parts: lastMessage.parts,
            feedback: null,
            model: null,
            inputTokens: null,
            outputTokens: null,
            durationMs: null,
            externalMessageId: null,
            source: "web",
            createdAt: new Date(),
          },
        ],
      };
    }

    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    if (chat.mode === "admin" && user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const isNewUserMessage =
      lastMessage?.role === "user" &&
      !chat.messages.some((message) => message.id === lastMessage.id);

    if (isNewUserMessage) {
      await saveKnowledgeMessages([
        {
          id: lastMessage.id,
          chatId: chat.id,
          role: "user",
          parts: lastMessage.parts,
        },
      ]);
    }

    return createKestrelOneAgentResponse({
      request,
      session,
      organizationId,
      chatId: chat.id,
      messages: body.messages,
      transientTitle:
        !chat.title && lastMessage?.role === "user"
          ? generateTitleFromUserMessage({
              message: lastMessage,
              modelId: body.model,
            })
          : null,
      onFinishPersist: async (messages, meta) => {
        const messagesForPersistence =
          prepareKestrelRuntimeMessagesForPersistence(messages, meta);

        const assistantMessages = messagesForPersistence.filter(
          (message) =>
            message.role === "assistant" &&
            isPersistableAssistantMessage(message)
        );

        const assistantMessagesToPersist = Array.from(
          new Map(
            assistantMessages.map((message) => [
              message.id,
              {
                id: message.id,
                chatId: chat.id,
                role: "assistant" as const,
                parts: message.parts,
                model: meta.model,
              },
            ])
          ).values()
        );

        await saveKnowledgeMessages(assistantMessagesToPersist);

        if (meta.title) {
          await updateChatTitleForUser({
            id: chat.id,
            userId: user.id,
            organizationId,
            title: meta.title,
          });
        }
      },
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const user = session.user as { id: string };

    const deleted = await deleteChatForUser(params.id, user.id, organizationId);

    if (!deleted) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
