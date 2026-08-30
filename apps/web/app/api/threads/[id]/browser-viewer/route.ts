import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveHostedBrowserViewerService } from "@/lib/browser/viewer-composition";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(request, context, false);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handle(request, context, true);
}

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
  mint: boolean,
) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
    const { id: threadId } = paramsSchema.parse(await context.params);
    const service = await resolveHostedBrowserViewerService({
      organizationId,
      actorId: session.user.id,
      threadId,
    });
    const body = mint
      ? await service.mintTicket({ organizationId, actorId: session.user.id, threadId })
      : await service.status({ organizationId, actorId: session.user.id, threadId });
    return NextResponse.json(body, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const code = readCode(error);
    return NextResponse.json(
      { error: { code } },
      {
        status: code === "BROWSER_SESSION_LOST" ? 404 : 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}

function readCode(error: unknown) {
  return error instanceof Error && error.message.startsWith("BROWSER_")
    ? error.message
    : "BROWSER_SERVICE_UNAVAILABLE";
}
