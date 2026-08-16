import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEnvironmentRuntimeChannel,
  listEnvironmentRuntimeCanaries,
  retryDesiredEnvironmentRuntime,
  selectPreviousEnvironmentRuntime,
  setEnvironmentRuntimeCanary,
} from "@/lib/environments/runtime-channel";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set-canary"),
      environmentId: z.string().uuid(),
    })
    .strict(),
  z.object({ action: z.literal("retry-desired") }).strict(),
  z.object({ action: z.literal("select-previous") }).strict(),
]);

export async function GET() {
  try {
    await requireAdmin();
    const [channel, canaries] = await Promise.all([
      getEnvironmentRuntimeChannel(),
      listEnvironmentRuntimeCanaries(),
    ]);
    return NextResponse.json({ channel, canaries });
  } catch (error) {
    return errorResponse(error, 409);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = inputSchema.parse(await request.json());
    if (input.action === "set-canary") {
      return NextResponse.json({
        channel: await setEnvironmentRuntimeCanary(input.environmentId),
      });
    }
    if (input.action === "retry-desired") {
      const requested = await retryDesiredEnvironmentRuntime();
      if (requested.operation.status === "queued") {
        await enqueueEnvironmentOperation(requested.operation.id);
      }
      return NextResponse.json({ operation: requested.operation });
    }
    return NextResponse.json({
      selection: await selectPreviousEnvironmentRuntime(),
    });
  } catch (error) {
    return errorResponse(error, 409);
  }
}
