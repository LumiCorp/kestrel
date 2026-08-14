import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueFlyImageRelease } from "@/lib/knowledge/queue";
import {
  acknowledgeFlyImageReleaseMigration,
  acknowledgeTurnWorkerConfiguration,
  approveFlyImageRelease,
  createFlyImageRollback,
  invalidateLegacyFlyImageRelease,
  listFlyImageReleaseCanaries,
  listFlyImageReleases,
  recoverFlyImageReleaseForward,
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
  z.object({
    action: z.literal("turn_worker_configuration_ready"),
    releaseId: z.string().uuid(),
  }),
  z.object({ action: z.literal("retry"), releaseId: z.string().uuid() }),
  z.object({ action: z.literal("rollback"), releaseId: z.string().uuid() }),
  z.object({ action: z.literal("recover_forward"), releaseId: z.string().uuid() }),
  z.object({ action: z.literal("invalidate_legacy"), releaseId: z.string().uuid() }),
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
    if (input.action === "invalidate_legacy") {
      return NextResponse.json({
        release: await invalidateLegacyFlyImageRelease(input.releaseId),
      });
    }
    const release =
      input.action === "migration_ready"
        ? await acknowledgeFlyImageReleaseMigration({
            releaseId: input.releaseId,
            actorUserId: session.user.id,
          })
        : input.action === "turn_worker_configuration_ready"
          ? await acknowledgeTurnWorkerConfiguration({
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
          : input.action === "recover_forward"
            ? await recoverFlyImageReleaseForward({
                releaseId: input.releaseId,
                actorUserId: session.user.id,
              })
          : await createFlyImageRollback({
              failedReleaseId: input.releaseId,
              actorUserId: session.user.id,
            });
    const acknowledgement =
      input.action === "migration_ready" ||
      input.action === "turn_worker_configuration_ready";
    if (release && !acknowledgement) {
      await enqueueFlyImageRelease(release.id);
    }
    return NextResponse.json(
      { release },
      { status: acknowledgement ? 200 : 202 },
    );
  } catch (error) {
    return errorResponse(error, 409);
  }
}
