import { NextResponse } from "next/server";
import { z } from "zod";
import {
  flyImageReleaseCandidatePublicationResponseSchema,
  flyImageReleaseManifestV3Schema,
} from "@/lib/releases/contracts";
import { verifyGithubActionsReleaseToken } from "@/lib/releases/github-oidc";
import {
  FlyImageReleaseError,
  acquireFlyImageReleaseAttempt,
  failFlyImageReleaseAttempt,
  getFlyImageReleasePublicationState,
  registerFlyImageReleaseCandidate,
  renewFlyImageReleaseAttempt,
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
  try {
    return NextResponse.json(await getFlyImageReleasePublicationState(), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    if (error instanceof FlyImageReleaseError) {
      return response(error.code, 409);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) {
      return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    }
    const body = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      (body as { version?: unknown }).version !== 3
    ) {
      return response("RELEASE_COMPATIBILITY_UNKNOWN", 409);
    }
    const manifest = flyImageReleaseManifestV3Schema.parse(body);
    try {
      const claims = await verifyGithubActionsReleaseToken({
        token,
        expectedSha: manifest.bundleRevision,
      });
      if (
        claims.run_id !== manifest.attempt.githubRunId ||
        Number(claims.run_attempt) !== manifest.attempt.githubRunAttempt
      ) {
        return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
      }
    } catch {
      return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    }
    const release = await registerFlyImageReleaseCandidate(manifest);
    return NextResponse.json(
      flyImageReleaseCandidatePublicationResponseSchema.parse({
        release: { id: release.id, status: release.status },
      }),
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

const acquireSchema = z
  .object({
    sourceRevision: revisionSchema,
    trigger: z.enum(["main", "scheduled", "manual"]),
    forceAll: z.boolean(),
    githubRunId: z.string().regex(/^\d+$/u),
    githubRunAttempt: z.number().int().positive(),
  })
  .strict();

export async function PUT(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    const input = acquireSchema.parse(await request.json());
    try {
      const claims = await verifyGithubActionsReleaseToken({
        token,
        expectedSha: input.sourceRevision,
      });
      if (
        claims.run_id !== input.githubRunId ||
        Number(claims.run_attempt) !== input.githubRunAttempt
      ) {
        return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
      }
    } catch {
      return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    }
    const attempt = await acquireFlyImageReleaseAttempt(input);
    return NextResponse.json(
      { attempt },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof z.ZodError)
      return response("RELEASE_ATTEMPT_INVALID", 400);
    if (error instanceof FlyImageReleaseError) return response(error.code, 409);
    console.error("Fly image release attempt acquisition failed.", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response("RELEASE_PUBLISH_FAILED", 500);
  }
}

const checkpointSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("renew"),
      attemptId: z.string().uuid(),
      sourceRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("fail"),
      attemptId: z.string().uuid(),
      sourceRevision: revisionSchema,
      evidence: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export async function PATCH(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    const input = checkpointSchema.parse(await request.json());
    let claims;
    try {
      claims = await verifyGithubActionsReleaseToken({
        token,
        expectedSha: input.sourceRevision,
      });
    } catch {
      return response("RELEASE_PUBLISH_UNAUTHORIZED", 401);
    }
    const attemptIdentity = {
      githubRunId: claims.run_id,
      githubRunAttempt: Number(claims.run_attempt),
    };
    const attempt =
      input.action === "renew"
        ? await renewFlyImageReleaseAttempt({ ...input, ...attemptIdentity })
        : await failFlyImageReleaseAttempt({ ...input, ...attemptIdentity });
    return NextResponse.json({ attempt }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof z.ZodError)
      return response("RELEASE_ATTEMPT_INVALID", 400);
    if (error instanceof FlyImageReleaseError) return response(error.code, 409);
    console.error("Fly image release attempt checkpoint failed.", {
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
