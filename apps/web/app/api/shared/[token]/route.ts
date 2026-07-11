import { NextResponse } from "next/server";
import { z } from "zod";
import { getPublicChatByShareToken } from "@/lib/agent/store";
import { errorResponse } from "@/lib/knowledge/http";
import { convertToUIMessages } from "@/lib/utils";

const paramsSchema = z.object({
  token: z.string().min(1),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = paramsSchema.parse(await context.params);
    const chat = await getPublicChatByShareToken(token);

    if (!chat) {
      return NextResponse.json(
        { error: "Shared chat not found or no longer public" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        id: chat.id,
        title: chat.title || "Shared Chat",
        createdAt: chat.createdAt,
        messages: convertToUIMessages(chat.messages),
        author: chat.author,
      },
      {
        headers: {
          "Cache-Control": "s-maxage=300, stale-while-revalidate=3600",
        },
      }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
