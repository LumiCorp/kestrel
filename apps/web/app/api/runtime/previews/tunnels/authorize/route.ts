import { NextResponse } from "next/server";
import {
  authorizeDesktopPreviewTunnel,
  DesktopPreviewError,
} from "@/lib/environments/desktop-preview";

export async function POST(request: Request) {
  try {
    return NextResponse.json(
      await authorizeDesktopPreviewTunnel(request, await request.json()),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof DesktopPreviewError ? error.status : 401;
    return NextResponse.json(
      {
        error: {
          code:
            error instanceof DesktopPreviewError
              ? error.code
              : "PREVIEW_TUNNEL_UNAUTHORIZED",
        },
      },
      { status },
    );
  }
}
