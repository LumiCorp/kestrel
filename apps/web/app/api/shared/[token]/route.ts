import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/knowledge/http";
import { getPublicThreadByShareToken } from "@/lib/threads/store";
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
    const thread = await getPublicThreadByShareToken(token);

    if (!thread) {
      return NextResponse.json(
        { error: "Shared thread not found or no longer public" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        id: thread.id,
        title: thread.title || "Shared Thread",
        createdAt: thread.createdAt,
        messages: convertToUIMessages(thread.messages),
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
