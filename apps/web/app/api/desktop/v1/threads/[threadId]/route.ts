import { NextResponse } from "next/server";
import {
  authorizeDesktopUser,
  getDesktopThreadProjection,
} from "@/lib/desktop-account";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  try {
    const { user } = await authorizeDesktopUser(request);
    const threadId = routeIdSchema.parse((await context.params).threadId);
    const thread = await getDesktopThreadProjection({
      threadId,
      userId: user.id,
    });
    return thread
      ? NextResponse.json(thread, {
          headers: { "cache-control": "no-store" },
        })
      : NextResponse.json({ error: "Thread not found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
