import { type NextRequest, NextResponse } from "next/server";
import { deleteUpload, readUpload } from "@/lib/files/storage";
import { assertUploadPathOwnedByUser } from "@/lib/files/upload-path";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  isInlineRenderableMediaType,
  normalizeMediaType,
} from "@/lib/knowledge/documents/shared";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ pathname: string[] }> }
) {
  try {
    const { session } = await requireActiveOrganization();
    const params = await context.params;
    assertUploadPathOwnedByUser(params.pathname, session.user.id);

    const file = await readUpload(params.pathname);
    const filename = params.pathname.at(-1) ?? "file";
    const mediaType = normalizeMediaType(undefined, filename);
    const disposition = isInlineRenderableMediaType(mediaType)
      ? "inline"
      : "attachment";

    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        "content-type": mediaType,
        "content-length": String(file.size),
        "content-disposition": `${disposition}; filename="${filename.replace(/[\r\n"]/g, "-")}"`,
      },
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ pathname: string[] }> }
) {
  try {
    const { session } = await requireActiveOrganization();
    const params = await context.params;
    assertUploadPathOwnedByUser(params.pathname, session.user.id);

    await deleteUpload(params.pathname);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
