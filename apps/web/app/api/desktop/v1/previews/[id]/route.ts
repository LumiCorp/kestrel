import { NextResponse } from "next/server";
import {
  DesktopPreviewError,
  renewDesktopPreview,
  unpublishDesktopPreview,
} from "@/lib/environments/desktop-preview";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await renewDesktopPreview(request, id), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return previewError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await unpublishDesktopPreview(request, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return previewError(error);
  }
}

function previewError(error: unknown) {
  const status = error instanceof DesktopPreviewError ? error.status : 400;
  const code =
    error instanceof DesktopPreviewError ? error.code : "PREVIEW_REQUEST_INVALID";
  return NextResponse.json({ error: { code } }, { status });
}
