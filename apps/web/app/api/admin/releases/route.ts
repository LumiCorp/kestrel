import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueFlyImageRelease } from "@/lib/knowledge/queue";
import {
  acknowledgeFlyImageReleaseMigration,
  approveFlyImageRelease,
  createFlyImageRollback,
  listFlyImageReleaseCanaries,
  listFlyImageReleases,
  retryFlyImageRelease,
  setFlyImageReleaseCanary,
} from "@/lib/releases/store";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_canary"),
    environmentId: z.string().uuid(),
  }),
  z.object({ action: z.literal("approve"), releaseId: z.string().uuid() }),
  z.object({
    action: z.literal("migration_ready"),
    releaseId: z.string().uuid(),
  }),
  z.object({ action: z.literal("retry"), releaseId: z.string().uuid() }),
  z.object({ action: z.literal("rollback"), releaseId: z.string().uuid() }),
]);

export async function GET() {
  try {
    await requireAdmin();
    const [releases, canaries] = await Promise.all([
      listFlyImageReleases(),
      listFlyImageReleaseCanaries(),
    ]);
    return NextResponse.json({ ...releases, canaries });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const input = actionSchema.parse(await request.json());
    if (input.action === "set_canary") {
      return NextResponse.json({
        settings: await setFlyImageReleaseCanary(input.environmentId),
      });
    }
    const release =
      input.action === "migration_ready"
        ? await acknowledgeFlyImageReleaseMigration({
            releaseId: input.releaseId,
            actorUserId: session.user.id,
          })
        : input.action === "approve"
        ? await approveFlyImageRelease({
            releaseId: input.releaseId,
            actorUserId: session.user.id,
          })
        : input.action === "retry"
          ? await retryFlyImageRelease(input.releaseId)
          : await createFlyImageRollback({
              failedReleaseId: input.releaseId,
              actorUserId: session.user.id,
            });
    if (release && input.action !== "migration_ready") {
      await enqueueFlyImageRelease(release.id);
    }
    return NextResponse.json(
      { release },
      { status: input.action === "migration_ready" ? 200 : 202 },
    );
  } catch (error) {
    return errorResponse(error, 409);
  }
}
