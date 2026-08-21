import { NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

/**
 * execution-protocol-v4 requires durable attachment identities and verified
 * streaming uploads. Older multipart clients must fail explicitly instead of
 * producing a file part that the runtime could silently omit.
 */
export async function PUT() {
  try {
    await requireActiveOrganization();
    return NextResponse.json(
      {
        error: "This attachment client is no longer compatible. Refresh Kestrel One and upload the file again.",
        code: "ATTACHMENT_PROTOCOL_UPGRADE_REQUIRED",
        requiredProtocol: "execution-protocol-v4",
      },
      { status: 410 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
