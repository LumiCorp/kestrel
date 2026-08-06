import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { runtimeDeploymentActionSchema } from "@/lib/runtime-deployments/contracts";
import {
  getRuntimeDeploymentStatus,
  retryRuntimeDeploymentCanary,
  retryRuntimeDeploymentResource,
  rollbackRuntimeDeploymentResource,
} from "@/lib/runtime-deployments/store";

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await getRuntimeDeploymentStatus());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = runtimeDeploymentActionSchema.parse(await request.json());
    const deployment =
      input.action === "retry_canary"
        ? await retryRuntimeDeploymentCanary()
        : input.action === "retry_resource"
          ? await retryRuntimeDeploymentResource(input)
          : await rollbackRuntimeDeploymentResource(input);
    return NextResponse.json(deployment, { status: 202 });
  } catch (error) {
    return errorResponse(error, 409);
  }
}
