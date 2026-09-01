import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { getProjectWorkflowRunForUser } from "@/lib/workflows/store";

const paramsSchema = z.object({ runId: routeIdSchema });

export async function GET(_request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { runId } = paramsSchema.parse(await context.params);
    return NextResponse.json({ run: await getProjectWorkflowRunForUser({ runId, organizationId, userId: session.user.id }) });
  } catch (error) {
    return errorResponse(error);
  }
}
