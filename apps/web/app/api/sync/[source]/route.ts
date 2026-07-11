import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { runSyncSingleSource } from "@/lib/knowledge/jobs";

const paramsSchema = z.object({
  source: z.string().min(1).max(200),
});

export async function POST(
  _request: Request,
  context: { params: Promise<{ source: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const params = paramsSchema.parse(await context.params);

    const result = await runSyncSingleSource(
      organizationId,
      params.source,
      session.user.id
    );

    return NextResponse.json({
      status: "started",
      runId: result.runId,
      message: `Sync workflow started for "${params.source}".`,
      source: params.source,
      snapshotRepo: result.snapshotRepo,
      snapshotBranch: result.snapshotBranch,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
