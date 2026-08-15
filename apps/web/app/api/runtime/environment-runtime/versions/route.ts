import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEnvironmentRuntimeChannel,
  registerEnvironmentRuntimeVersion,
} from "@/lib/environments/runtime-channel";
import {
  authorizeRuntimeWorkflow,
  runtimeWorkflowError,
  workflowIdentitySchema,
} from "../shared";

const digestRecordSchema = z
  .object({
    image: z.string().regex(/^ghcr\.io\/lumicorp\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/u),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict();

const inputSchema = workflowIdentitySchema.extend({
  workspaceRuntime: digestRecordSchema.extend({
    image: z.string().regex(/^ghcr\.io\/lumicorp\/kestrel-workspace-runtime@sha256:[0-9a-f]{64}$/u),
  }),
  environmentRouter: digestRecordSchema.extend({
    image: z.string().regex(/^ghcr\.io\/lumicorp\/kestrel-environment-router@sha256:[0-9a-f]{64}$/u),
  }),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const identity = workflowIdentitySchema.parse({
      workflowRevision: url.searchParams.get("workflowRevision"),
      githubRunId: url.searchParams.get("githubRunId"),
      githubRunAttempt: Number(url.searchParams.get("githubRunAttempt")),
    });
    await authorizeRuntimeWorkflow(request, identity);
    return NextResponse.json({ channel: await getEnvironmentRuntimeChannel() });
  } catch (error) {
    return runtimeWorkflowError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    await authorizeRuntimeWorkflow(request, input);
    const result = await registerEnvironmentRuntimeVersion({
      runtimeImage: input.workspaceRuntime.image,
      runtimeSourceRevision: input.workspaceRuntime.sourceRevision,
      routerImage: input.environmentRouter.image,
      routerSourceRevision: input.environmentRouter.sourceRevision,
      githubRunId: input.githubRunId,
      githubRunAttempt: input.githubRunAttempt,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return runtimeWorkflowError(error);
  }
}
