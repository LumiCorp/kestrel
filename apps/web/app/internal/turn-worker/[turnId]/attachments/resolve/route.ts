import { NextResponse } from "next/server";
import {
  TurnAttachmentResolutionTicketError,
  verifyTurnAttachmentResolutionTicket,
} from "@lumi/kestrel-environment-auth";
import { z } from "zod";
import {
  resolveTurnAttachments,
  TurnAttachmentResolutionError,
} from "@/lib/files/turn-attachment-resolver";
import { resolveTurnAttachmentDeploymentCanary } from "@/lib/files/turn-attachment-deployment-canary";
import { TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID } from "@kestrel-agents/protocol";

const paramsSchema = z.object({ turnId: z.string().trim().min(1).max(200) });
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ turnId: string }> },
) {
  try {
    const { turnId } = paramsSchema.parse(await context.params);
    const ticket = verifyTurnAttachmentResolutionTicket({
      token: readBearer(request.headers.get("authorization")),
      publicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    });
    if (ticket.turnId !== turnId) {
      throw new TurnAttachmentResolutionTicketError(
        "TICKET_INVALID",
        "Attachment resolution ticket does not match this turn.",
      );
    }
    const result = turnId === TURN_ATTACHMENT_DEPLOYMENT_CANARY_TURN_ID
      ? await resolveTurnAttachmentDeploymentCanary()
      : await resolveTurnAttachments({ turnId });
    return NextResponse.json(result, {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    if (error instanceof TurnAttachmentResolutionTicketError) {
      return NextResponse.json(
        { error: { code: "ATTACHMENT_ACCESS_UNAUTHORIZED" } },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof TurnAttachmentResolutionError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            ...(error.fileId ? { fileId: error.fileId } : {}),
          },
        },
        {
          status:
            error.code === "ATTACHMENT_ACCESS_UNAUTHORIZED"
              ? 401
              : error.code === "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE"
                ? 503
                : error.code === "ATTACHMENT_SET_INVALID"
                  ? 409
                  : 422,
          headers: NO_STORE_HEADERS,
        },
      );
    }
    return NextResponse.json(
      { error: { code: "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE" } },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

function readBearer(value: string | null) {
  const match = value?.match(/^Bearer\s+([^\s]+)$/u);
  if (!match?.[1]) {
    throw new TurnAttachmentResolutionTicketError(
      "TICKET_INVALID",
      "Attachment resolution ticket is required.",
    );
  }
  return match[1];
}
