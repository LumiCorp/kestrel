import { NextResponse } from "next/server";
import {
  PreviewEdgeRouteError,
  resolvePreviewEdgeRoute,
} from "@/lib/environments/preview-edge-route";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
} as const;

export async function GET(request: Request) {
  try {
    return NextResponse.json(
      await resolvePreviewEdgeRoute({
        authorization: request.headers.get("authorization"),
        hostname: new URL(request.url).searchParams.get("hostname") ?? "",
        accessToken: request.headers.get("x-kestrel-preview-access"),
      }),
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof PreviewEdgeRouteError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(
      { error: { code: "PREVIEW_EDGE_ROUTE_RESOLUTION_FAILED" } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
