import { waitUntil } from "@vercel/functions";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleDiscordWebhook } from "@/lib/bots/discord";
import { handleGitHubWebhook } from "@/lib/bots/github";
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
      return handleGitHubWebhook(request, request.nextUrl.origin, waitUntil);
    }

    return handleDiscordWebhook(request, request.nextUrl.origin, waitUntil);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
