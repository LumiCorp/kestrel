import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEnvironmentRuntimeCanary,
  requestEnvironmentRuntimeCanary,
} from "@/lib/environments/runtime-channel";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import {
  authorizeRuntimeWorkflow,
  runtimeWorkflowError,
  workflowIdentitySchema,
} from "../../../shared";

const paramsSchema = z.object({ id: z.string().min(1) });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = paramsSchema.parse(await context.params);
    const identity = workflowIdentitySchema.parse(await request.json());
    await authorizeRuntimeWorkflow(request, identity);
    const requested = await requestEnvironmentRuntimeCanary({ runtimeVersionId: id });
    if (requested.operation.status === "queued") {
      await enqueueEnvironmentOperation(requested.operation.id);
    }
    return NextResponse.json({ operation: requested.operation }, { status: 202 });
  } catch (error) {
    return runtimeWorkflowError(error);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = paramsSchema.parse(await context.params);
    const url = new URL(request.url);
    const identity = workflowIdentitySchema.parse({
      workflowRevision: url.searchParams.get("workflowRevision"),
      githubRunId: url.searchParams.get("githubRunId"),
      githubRunAttempt: Number(url.searchParams.get("githubRunAttempt")),
    });
    await authorizeRuntimeWorkflow(request, identity);
    const operation = await getEnvironmentRuntimeCanary(id);
    if (!operation) {
      return NextResponse.json(
        { error: { code: "RUNTIME_CANARY_NOT_REQUESTED" } },
        { status: 404 },
      );
    }
    return NextResponse.json({ operation });
  } catch (error) {
    return runtimeWorkflowError(error);
  }
}
