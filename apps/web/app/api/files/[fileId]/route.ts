import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteDraftThreadFile,
  getFileMetadataForUser,
  uploadThreadFile,
} from "@/lib/files/service";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({ fileId: z.string().min(1) });

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { fileId } = paramsSchema.parse(await context.params);
    const file = await getFileMetadataForUser({ fileId, organizationId, userId: session.user.id });
    return NextResponse.json({
      fileId: file.id,
      filename: file.filename,
      declaredMediaType: file.declaredMediaType,
      detectedMediaType: file.detectedMediaType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      state: file.lifecycleState,
      representation: file.representationStatus,
      metadataOnlyReason: file.metadataOnlyReason,
      scopes: file.scopes,
      downloadUrl: `/api/files/${encodeURIComponent(file.id)}/content`,
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { fileId } = paramsSchema.parse(await context.params);
    const threadId = new URL(request.url).searchParams.get("threadId")?.trim();
    if (!threadId) throw new Error("Thread ID is required.");
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
    if (contentLength !== undefined && !Number.isSafeInteger(contentLength)) {
      throw new Error("Content-Length is invalid.");
    }
    const file = await uploadThreadFile({
      fileId,
      threadId,
      organizationId,
      userId: session.user.id,
      body: request.body,
      contentLength,
    });
    return NextResponse.json({
      fileId: file.id,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      detectedMediaType: file.detectedMediaType,
      sha256: file.sha256,
      state: file.lifecycleState,
      representation: file.representationStatus,
      metadataOnlyReason: file.metadataOnlyReason,
      downloadUrl: `/api/files/${encodeURIComponent(file.id)}/content`,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { fileId } = paramsSchema.parse(await context.params);
    const threadId = new URL(request.url).searchParams.get("threadId")?.trim();
    if (!threadId) throw new Error("Thread ID is required.");
    return NextResponse.json({
      deleted: await deleteDraftThreadFile({
        fileId,
        threadId,
        organizationId,
        userId: session.user.id,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
