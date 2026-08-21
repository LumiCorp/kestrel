import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertRunnerFileThreadBinding,
  parseRunnerKnowledgeCapabilityRequest,
} from "@/lib/agent/kestrel-capabilities";
import { getVisibleFileForThread } from "@/lib/files/service";
import { getManagedFileStorageProvider } from "@/lib/files/storage-provider";
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
    const file = await getVisibleFileForThread({
      fileId: payload.fileId,
      threadId,
      organizationId: identity.organizationId,
      userId: identity.userId,
    });
    if (file.lifecycleState !== "ready") throw new Error("File is unavailable.");
    const storage = getManagedFileStorageProvider();
    const sourceUrl = storage.signedReadUrl
      ? await storage.signedReadUrl(file.objectKey, 900)
      : undefined;
    return NextResponse.json({
      fileId: file.id,
      filename: file.filename,
      mediaType: file.detectedMediaType ?? file.declaredMediaType ?? "application/octet-stream",
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      representation: file.representationStatus,
      ...(file.representationText ? { text: file.representationText, truncated: file.textTruncated } : {}),
      ...(file.metadataOnlyReason ? { metadataOnlyReason: file.metadataOnlyReason } : {}),
      ...(sourceUrl ? { sourceUrl, sourceUrlExpiresInSeconds: 900 } : {}),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
