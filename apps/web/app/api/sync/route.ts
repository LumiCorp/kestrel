import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { runSyncAllSources } from "@/lib/knowledge/jobs";

const bodySchema = z
  .object({
    sourceFilter: z.string().min(1).max(200).optional(),
  })
  .optional();

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const raw = await request.json().catch(() => {});
    const body = bodySchema.parse(raw);

    const result = await runSyncAllSources(
      organizationId,
      body?.sourceFilter,
      session.user.id
    );
    if (result.sourceCount === 0) {
      return NextResponse.json(
        { error: "No sources to sync" },
        { status: 400 }
      );
    }

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "sync",
      action: "run-all",
      targetType: "source_sync",
      targetId: result.runId,
      message: `Started sync for ${result.sourceCount} source(s).`,
      metadata: {
        sourceFilter: body?.sourceFilter ?? null,
        sourceCount: result.sourceCount,
      },
    });

    return NextResponse.json({
      status: "started",
      runId: result.runId,
      message: `Sync workflow started for ${result.sourceCount} source(s).`,
      sourceCount: result.sourceCount,
      snapshotRepo: result.snapshotRepo,
      snapshotBranch: result.snapshotBranch,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
