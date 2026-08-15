import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyEnvironmentRuntimeWorkflowToken } from "@/lib/runtime/github-actions-oidc";
import { EnvironmentRuntimeChannelError } from "@/lib/environments/runtime-channel";

export const workflowIdentitySchema = z
  .object({
    workflowRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    githubRunId: z.string().regex(/^\d+$/u),
    githubRunAttempt: z.number().int().positive(),
  })
  .strict();

export function bearerToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1];
}

export async function authorizeRuntimeWorkflow(
  request: Request,
  identity: z.infer<typeof workflowIdentitySchema>,
) {
  const token = bearerToken(request);
  if (!token) throw new Error("RUNTIME_WORKFLOW_UNAUTHORIZED");
  return verifyEnvironmentRuntimeWorkflowToken({
    token,
    expectedWorkflowSha: identity.workflowRevision,
    expectedRunId: identity.githubRunId,
    expectedRunAttempt: identity.githubRunAttempt,
  });
}

export function runtimeWorkflowError(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: "RUNTIME_WORKFLOW_INPUT_INVALID" } },
      { status: 400 },
    );
  }
  if (error instanceof EnvironmentRuntimeChannelError) {
    const status = error.code === "RUNTIME_VERSION_NOT_FOUND" ? 404 : 409;
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  if (
    error instanceof Error &&
    (error.message === "RUNTIME_WORKFLOW_UNAUTHORIZED" ||
      error.message.includes("GitHub Actions OIDC"))
  ) {
    return NextResponse.json(
      { error: { code: "RUNTIME_WORKFLOW_UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  console.error("Environment Runtime workflow request failed.", {
    message: error instanceof Error ? error.message : "Unknown error",
  });
  return NextResponse.json(
    { error: { code: "RUNTIME_WORKFLOW_FAILED" } },
    { status: 500 },
  );
}
