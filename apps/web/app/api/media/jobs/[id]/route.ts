import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMediaGenerationJobForUser } from "@/lib/ai/media";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const job = await getMediaGenerationJobForUser({
      jobId: params.id,
      organizationId,
      userId: session.user.id,
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
