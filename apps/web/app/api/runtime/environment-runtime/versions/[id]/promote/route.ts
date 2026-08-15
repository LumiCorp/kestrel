import { NextResponse } from "next/server";
import { z } from "zod";
import { promoteEnvironmentRuntimeVersion } from "@/lib/environments/runtime-channel";
import {
  authorizeRuntimeWorkflow,
  runtimeWorkflowError,
  workflowIdentitySchema,
} from "../../../shared";

const paramsSchema = z.object({ id: z.string().min(1) });
const inputSchema = workflowIdentitySchema.extend({
  expectedCurrentVersionId: z.string().min(1).nullable(),
  expectedGeneration: z.number().int().nonnegative(),
  canaryOperationId: z.string().min(1),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = paramsSchema.parse(await context.params);
    const input = inputSchema.parse(await request.json());
    await authorizeRuntimeWorkflow(request, input);
    return NextResponse.json(
      await promoteEnvironmentRuntimeVersion({
        runtimeVersionId: id,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        expectedGeneration: input.expectedGeneration,
        canaryOperationId: input.canaryOperationId,
        githubRunId: input.githubRunId,
        githubRunAttempt: input.githubRunAttempt,
      }),
    );
  } catch (error) {
    return runtimeWorkflowError(error);
  }
}
