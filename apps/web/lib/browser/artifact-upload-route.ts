import { NextResponse } from "next/server";
import type { HostedBrowserArtifactAuthority } from "./artifact-authority";

type ArtifactUploader = Pick<HostedBrowserArtifactAuthority, "upload">;

export async function handleHostedBrowserArtifactUpload(input: {
  request: Request;
  fileId: string;
  authority: ArtifactUploader;
}) {
  try {
    if (!/^file-browser-[0-9a-f]{64}$/u.test(input.fileId)) {
      throw artifactUploadError("BROWSER_ARTIFACT_UPLOAD_DENIED", 401);
    }
    const authorization = input.request.headers.get("authorization") ?? "";
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u);
    if (!match?.[1]) {
      throw artifactUploadError("BROWSER_ARTIFACT_UPLOAD_DENIED", 401);
    }
    const rawLength = input.request.headers.get("content-length");
    const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw artifactUploadError("BROWSER_ARTIFACT_UPLOAD_DENIED", 400);
    }
    const file = await input.authority.upload({
      token: match[1],
      fileId: input.fileId,
      body: input.request.body,
      contentLength,
    });
    return NextResponse.json({
      artifactId: file.id,
      state: file.lifecycleState,
      mediaType: file.detectedMediaType,
      bytes: file.sizeBytes,
      sha256: file.sha256,
    });
  } catch (error) {
    const status = readUploadStatus(error);
    return NextResponse.json(
      {
        error: {
          code: status === 413
            ? "BROWSER_ARTIFACT_TOO_LARGE"
            : "BROWSER_ARTIFACT_UPLOAD_DENIED",
        },
      },
      { status },
    );
  }
}

function artifactUploadError(code: string, status: number) {
  return Object.assign(new Error(code), { status });
}

function readUploadStatus(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    (error.status === 400 || error.status === 401 || error.status === 413)
  ) return error.status;
  if (
    error instanceof Error &&
    error.message === "BROWSER_ARTIFACT_TOO_LARGE"
  ) return 413;
  return 401;
}
