import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { requireAdmin } from "@/lib/knowledge/auth";
import { enqueueTurnWorkerCapacityOperation } from "@/lib/knowledge/queue";
import {
  failQueuedTurnWorkerCapacityOperation,
  getTurnWorkerCapacitySnapshot,
  requestTurnWorkerCapacityOperation,
  TurnWorkerCapacityError,
} from "@/lib/platform/turn-worker-capacity";

const capacityRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedInventoryFingerprint: z.string().min(1),
    concurrencyPerMachine: z.number().int().min(1).max(64),
    activeMachineCount: z.number().int().min(1).max(8),
  })
  .strict();

const STATUS_BY_CODE = {
  INVALID_CAPACITY: 400,
  RUNTIME_STATE_STALE: 409,
  RUNTIME_OPERATION_ACTIVE: 409,
  TURN_WORKERS_BUSY: 409,
  TURN_WORKER_INVENTORY_DRIFT: 409,
  FLY_INVENTORY_UNAVAILABLE: 503,
} as const;

async function capacityErrorResponse(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { code: "INVALID_CAPACITY", error: "Invalid Turn Worker capacity request." },
      { status: 400 },
    );
  }
  if (error instanceof TurnWorkerCapacityError) {
    const refreshedState =
      error.code === "RUNTIME_STATE_STALE"
        ? await getTurnWorkerCapacitySnapshot().catch(() => null)
        : null;
    return NextResponse.json(
      {
        code: error.code,
        error: error.message,
        ...error.detail,
        ...(refreshedState ? { state: refreshedState } : {}),
      },
      { status: STATUS_BY_CODE[error.code] },
    );
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message === "Forbidden" || message === "Unauthorized") {
    return NextResponse.json(
      { code: "ADMIN_REQUIRED", error: "Platform administrator access is required." },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { code: "RUNTIME_UNAVAILABLE", error: "Turn Worker capacity is unavailable." },
    { status: 503 },
  );
}

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await getTurnWorkerCapacitySnapshot());
  } catch (error) {
    return capacityErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  let actorUserId: string | null = null;
  try {
    const session = await requireAdmin();
    actorUserId = session.user.id;
    const body = capacityRequestSchema.parse(await request.json());
    const operation = await requestTurnWorkerCapacityOperation({
      actorUserId,
      ...body,
    });
    try {
      await enqueueTurnWorkerCapacityOperation(operation.operationId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Capacity queue unavailable.";
      await failQueuedTurnWorkerCapacityOperation(operation.operationId, message);
      throw error;
    }
    return NextResponse.json(operation, { status: 202 });
  } catch (error) {
    if (actorUserId) {
      await logAdminEvent({
        actorUserId,
        level: "warn",
        category: "turn-worker-capacity",
        action: "rejected",
        targetType: "platform_turn_worker_capacity",
        targetId: "default",
        message: "Rejected a Turn Worker capacity request.",
        metadata: {
          code:
            error instanceof TurnWorkerCapacityError
              ? error.code
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? "INVALID_CAPACITY"
                : "RUNTIME_UNAVAILABLE",
        },
      }).catch(() => {});
    }
    return capacityErrorResponse(error);
  }
}
