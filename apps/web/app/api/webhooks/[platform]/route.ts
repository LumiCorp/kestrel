import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleDiscordWebhook } from "@/lib/bots/discord";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  platform: z.enum(["github", "discord"]),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
) {
  try {
    const { platform } = paramsSchema.parse(await context.params);

    if (platform === "github") {
      return Response.json(
        {
          error:
            "The GitHub bot has been retired. GitHub remains available through Apps and Project workspaces.",
        },
        { status: 410 }
      );
    }

    return handleDiscordWebhook(request, request.nextUrl.origin);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
