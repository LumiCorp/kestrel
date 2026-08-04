import { NextResponse } from "next/server";
import { z } from "zod";
import { flyImageReleaseManifestV1Schema } from "@/lib/releases/contracts";
import { verifyGithubActionsReleaseToken } from "@/lib/releases/github-oidc";
import {
  FlyImageReleaseError,
  getFlyImageReleasePublicationState,
  registerFlyImageReleaseCandidate,
} from "@/lib/releases/store";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/u, "Expected a full Git revision.");

export async function GET(request: Request) {
  const revision = revisionSchema.safeParse(
    new URL(request.url).searchParams.get("revision"),
  );
  if (!revision.success) return response("RELEASE_REVISION_INVALID", 400);
  const token = bearerToken(request);
  if (!token) return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
  try {
    await verifyGithubActionsReleaseToken({
      token,
      expectedSha: revision.data,
    });
  } catch {
    return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
  }
  return NextResponse.json(
    await getFlyImageReleasePublicationState(),
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) {
      return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    }
    const manifest = flyImageReleaseManifestV1Schema.parse(
      await request.json(),
    );
    try {
      await verifyGithubActionsReleaseToken({
        token,
        expectedSha: manifest.bundleRevision,
      });
    } catch {
      return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    }
    const release = await registerFlyImageReleaseCandidate(manifest);
    return NextResponse.json(
      { release: { id: release.id, status: release.status } },
      { status: 202, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return response("RELEASE_MANIFEST_INVALID", 400);
    }
    if (error instanceof FlyImageReleaseError) {
      return response(error.code, 409);
    }
    console.error("Fly image release candidate publication failed.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response("RELEASE_PUBLISH_FAILED", 500);
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
