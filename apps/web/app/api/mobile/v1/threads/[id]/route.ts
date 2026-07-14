import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileThreadDtos } from "@/lib/mobile/dto";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";
import { convertToUIMessages } from "@/lib/utils";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const thread = await getThreadWithMessagesForUser(
      id,
      session.user.id,
      organizationId
    );
    if (!thread || thread.mode !== "chat") {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return NextResponse.json({
      thread: (await mobileThreadDtos([thread]))[0],
      messages: convertToUIMessages(thread.messages),
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
