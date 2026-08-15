import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEnvironmentRuntimeChannel,
  listEnvironmentRuntimeCanaries,
  setEnvironmentRuntimeCanary,
} from "@/lib/environments/runtime-channel";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const inputSchema = z.object({ environmentId: z.string().uuid() }).strict();

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
    const { environmentId } = inputSchema.parse(await request.json());
    return NextResponse.json({
      channel: await setEnvironmentRuntimeCanary(environmentId),
    });
  } catch (error) {
    return errorResponse(error, 409);
  }
}
