import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { assertRuntimeReleased } from "@/lib/runtimes/release-gate";
import { describeRuntimeForAdmission } from "@/lib/runtimes/descriptor-service";

const requestSchema = z
  .object({
    runtimeId: z.enum(["kestrel", "codex", "claude"]),
    modelId: z.string().trim().min(1).max(200).optional(),
    projectId: routeIdSchema.nullable().optional(),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const input = requestSchema.parse(await request.json());
    assertRuntimeReleased(input.runtimeId);
    if (input.runtimeId === "kestrel") {
      const descriptor = {
        version: "runtime_descriptor_v1" as const,
        runtimeId: "kestrel" as const,
        displayName: "Kestrel",
        adapterContractVersion: 1,
        nativeVersion: "0.7.0",
        availability: "ready" as const,
        interactionStrategies: ["deferred_session" as const],
        capabilities: {
          modes: ["chat" as const, "plan" as const, "build" as const],
          continuation: true,
          cancellation: true,
          usage: true,
          attachments: ["image" as const, "text" as const],
          conversationPersistence: "native_resume" as const,
          interactionRecovery: "durable_resume" as const,
        },
      };
      return NextResponse.json({
        resolution: {
          version: "runtime_descriptor_resolution_v1",
          descriptor,
          profileFingerprint: createHash("sha256")
            .update("kestrel:product")
            .digest("hex"),
          capabilityDigest: createHash("sha256")
            .update(JSON.stringify(descriptor.capabilities))
            .digest("hex"),
          environmentId: "product",
          observedAt: new Date().toISOString(),
        },
      });
    }
    const resolution = await describeRuntimeForAdmission({
      organizationId,
      userId: session.user.id,
      runtimeId: input.runtimeId,
      modelId: input.modelId,
      projectId: input.projectId,
    });
    return NextResponse.json({ resolution });
  } catch (error) {
    return errorResponse(error, 409);
  }
}
