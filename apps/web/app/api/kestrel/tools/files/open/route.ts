import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertRunnerFileThreadBinding,
  parseRunnerKnowledgeCapabilityRequest,
} from "@/lib/agent/kestrel-capabilities";
import { openVisibleFileForThread } from "@/lib/files/service";
import { errorResponse } from "@/lib/knowledge/http";
import { requireActiveOrganization } from "@/lib/knowledge/auth";

const payloadSchema = z.object({ fileId: z.string().trim().min(1).max(200) }).strict();

export async function POST(request: Request) {
  try {
    const identity = request.headers.has("authorization")
      ? parseRunnerKnowledgeCapabilityRequest({
          request,
          expectedToken: process.env.KESTREL_ONE_TOOL_TOKEN,
          environmentTicketPublicKey:
            process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY,
        })
      : await requireActiveOrganization().then((active) => ({
          organizationId: active.organizationId,
          userId: active.session.user.id,
        }));
    const threadId = new URL(request.url).searchParams.get("threadId")?.trim();
    if (!threadId) throw new Error("Thread file context is required.");
    if (request.headers.has("authorization")) {
      assertRunnerFileThreadBinding(identity, threadId);
    }
    const payload = payloadSchema.parse(await request.json());
    return NextResponse.json(await openVisibleFileForThread({
      fileId: payload.fileId,
      threadId,
      organizationId: identity.organizationId,
      userId: identity.userId,
    }));
  } catch (error) {
    return errorResponse(error, 400);
  }
}
