import { NextResponse } from "next/server";
import { z } from "zod";
import {
  RELEASE_PREPARATION_WORKFLOW_REF,
  verifyGithubActionsReleaseToken,
} from "@/lib/releases/github-oidc";
import {
  completeFlyImageReleasePreparation,
  FlyImageReleaseError,
  getFlyImageReleasePreparation,
} from "@/lib/releases/store";

const inputSchema = z.object({
  releaseId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
});

const headers = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export async function GET(request: Request) {
  return handle(request, false);
}

export async function POST(request: Request) {
  return handle(request, true);
}

async function handle(request: Request, complete: boolean) {
  try {
    const url = new URL(request.url);
    const input = complete
      ? inputSchema.parse(await request.json())
      : inputSchema.parse({
          releaseId: url.searchParams.get("releaseId"),
          revision: url.searchParams.get("revision"),
        });
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer ([^\s]+)$/u)?.[1];
    if (!token) return response("RELEASE_PREPARE_UNAUTHORIZED", 401);
    try {
      await verifyGithubActionsReleaseToken({
        token,
        expectedSha: input.revision,
        expectedWorkflowRef: RELEASE_PREPARATION_WORKFLOW_REF,
      });
    } catch {
      return response("RELEASE_PREPARE_UNAUTHORIZED", 401);
    }
    const preparation = await getFlyImageReleasePreparation(input.releaseId);
    if (preparation.bundleRevision !== input.revision) {
      return response("RELEASE_BUILD_REVISION_MISMATCH", 409);
    }
    if (!complete) return NextResponse.json({ preparation }, { headers });
    const release = await completeFlyImageReleasePreparation(input.releaseId);
    return NextResponse.json({ release }, { headers });
  } catch (error) {
    if (error instanceof z.ZodError)
      return response("RELEASE_PREPARE_INVALID", 400);
    if (error instanceof FlyImageReleaseError) return response(error.code, 409);
    console.error("Fly image release preparation failed.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response("RELEASE_PREPARE_FAILED", 500);
  }
}

function response(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status, headers });
}
