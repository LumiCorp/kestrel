import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveMcpInteraction } from "@/lib/mcp/interactions";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshot } from "@/lib/mobile/snapshot";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import {
  listThreadInteractionsForUser,
  resolveDurableRuntimeInteraction,
} from "@/lib/turns/store";

const paramsSchema = z.object({
  id: routeIdSchema,
  checkpointId: routeIdSchema,
});
const bodySchema = z.object({
  decision: z.enum(["approve", "deny"]),
  content: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    )
    .optional(),
  message: z.string().trim().min(1).max(20_000).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const ledger = await listThreadInteractionsForUser({
      organizationId,
      threadId: params.id,
      userId: session.user.id,
    });
    const pending = ledger.find(
      (interaction) => interaction.requestId === params.checkpointId
    );
    if (!pending) {
      throw new Error("Pending interaction not found.");
    }
    if (pending.source === "runtime") {
      const message =
        body.message ??
        (pending.kind === "approval"
          ? body.decision === "approve"
            ? "Approved"
            : "Denied"
          : typeof body.content?.answer === "string"
            ? body.content.answer
            : JSON.stringify(body.content ?? {}));
      const resumed = await resolveDurableRuntimeInteraction({
        organizationId,
        threadId: params.id,
        userId: session.user.id,
        requestId: pending.requestId,
        eventType: pending.eventType,
        message,
        ...(pending.kind === "approval"
          ? { approved: body.decision === "approve" }
          : {}),
        messageId: crypto.randomUUID(),
        source: "mobile",
      });
      if (resumed.shouldDispatch) {
        await enqueueDurableThreadTurn(resumed.turnId);
      }
    } else {
      if (!pending.sourceCheckpointId) {
        throw new Error("MCP interaction checkpoint is missing.");
      }
      await resolveMcpInteraction({
        organizationId,
        threadId: params.id,
        userId: session.user.id,
        checkpointId: pending.sourceCheckpointId,
        ...body,
      });
    }
    const snapshot = await getMobileThreadSnapshot({
      threadId: params.id,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json({ snapshot });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
