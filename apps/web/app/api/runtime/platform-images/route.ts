import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyGithubActionsReleaseToken } from "@/lib/releases/github-oidc";
import {
  platformImagePublicationSchema,
  sourceRevisionSchema,
} from "@/lib/runtime-deployments/contracts";
import {
  getPlatformImagePublicationState,
  PlatformRuntimeDeploymentError,
  publishPlatformImages,
} from "@/lib/runtime-deployments/store";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function GET(request: Request) {
  const sourceRevision = sourceRevisionSchema.safeParse(
    new URL(request.url).searchParams.get("sourceRevision"),
  );
  if (!sourceRevision.success) return response("SOURCE_REVISION_INVALID", 400);
  const token = bearerToken(request);
  if (!token) return response("PLATFORM_IMAGE_PUBLISH_UNAUTHORIZED", 401);
  try {
    await verifyGithubActionsReleaseToken({
      token,
      expectedSha: sourceRevision.data,
    });
    return NextResponse.json(
      await getPlatformImagePublicationState(sourceRevision.data),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof PlatformRuntimeDeploymentError) {
      return response(error.code, 409);
    }
    return response("PLATFORM_IMAGE_PUBLISH_UNAUTHORIZED", 401);
  }
}

export async function POST(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) return response("PLATFORM_IMAGE_PUBLISH_UNAUTHORIZED", 401);
    const input = platformImagePublicationSchema.parse(await request.json());
    const claims = await verifyGithubActionsReleaseToken({
      token,
      expectedSha: input.sourceRevision,
    });
    if (input.rollout.mode === "maintenance") {
      if (!input.activateMaintenance || claims.event_name !== "workflow_dispatch") {
        return response("MAINTENANCE_ACTIVATION_REQUIRES_EXACT_SHA_DISPATCH", 409);
      }
    } else if (input.activateMaintenance) {
      return response("ROLLING_ACTIVATION_INVALID", 400);
    }
    return NextResponse.json(await publishPlatformImages(input), {
      status: 202,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return response("PLATFORM_IMAGE_PUBLICATION_INVALID", 400);
    }
    if (error instanceof PlatformRuntimeDeploymentError) {
      return response(error.code, 409);
    }
    console.error("Platform image publication failed.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response("PLATFORM_IMAGE_PUBLICATION_FAILED", 500);
  }
}

function bearerToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1];
}

function response(code: string, status: number) {
  return NextResponse.json(
    { error: { code } },
    { status, headers: NO_STORE_HEADERS },
  );
}
