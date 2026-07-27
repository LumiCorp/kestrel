import { NextResponse } from "next/server";
import {
  DesktopPreviewError,
  publishDesktopPreview,
} from "@/lib/environments/desktop-preview";

export async function POST(request: Request) {
  try {
    return NextResponse.json(
      await publishDesktopPreview(request, await request.json()),
      { status: 201, headers: { "cache-control": "no-store" } },
    );
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
