import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { resolveMcpInteraction } from "@/lib/mcp/interactions";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import {
  listThreadInteractionsForUser,
  resolveDurableRuntimeInteraction,
} from "@/lib/turns/store";
import {
  isRecoveryReviewRequest,
  readRecoveryReviewEnvelope,
  recoveryOptionLabel,
} from "@/lib/turns/recovery-review";

const paramsSchema = z.object({
  id: routeIdSchema,
  checkpointId: routeIdSchema,
});
const bodySchema = z.object({
  decision: z.enum(["approve", "deny", "decline", "approve_once"]).optional(),
  recoveryOptionId: z.string().trim().min(1).max(256).optional(),
  content: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    )
    .optional(),
  message: z.string().trim().min(1).max(20_000).optional(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
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
      if (!pending.turnId) {
        throw new Error("Pending runtime interaction is not attached to a turn.");
      }
      const recoveryReview = readRecoveryReviewEnvelope(
        pending.requestEnvelope,
      );
      const recoveryReviewDeclared = isRecoveryReviewRequest(
        pending.requestEnvelope,
      );
      const answer = typeof body.content?.answer === "string"
        ? body.content.answer.trim() || undefined
        : undefined;
      const hostedV2Approval =
        pending.kind === "approval" &&
        pending.requestEnvelope.version ===
          "runner_hosted_tool_approval_interaction_v2";
      if (pending.kind === "approval" && body.decision === undefined) {
        throw new Error("An approval interaction requires a decision.");
      }
      if (
        pending.kind === "approval" &&
        (hostedV2Approval
          ? body.decision !== "decline" && body.decision !== "approve_once"
          : body.decision !== "approve" && body.decision !== "deny")
      ) {
        throw new Error("The approval decision does not match its version.");
      }
      if (
        recoveryReviewDeclared &&
        (recoveryReview === null ||
          body.recoveryOptionId === undefined ||
          recoveryReview.bindingId !== pending.requestId ||
          recoveryReview.allowedOptionIds.includes(body.recoveryOptionId) === false)
      ) {
        const snapshot = await getMobileThreadSnapshotForRequest(request, {
          threadId: params.id,
          organizationId,
          userId: session.user.id,
        });
        return NextResponse.json(
          {
            error: {
              code: "RECOVERY_OPTION_CONFLICT",
              message: "Select one exact allowed recovery option.",
            },
            snapshot,
          },
          { status: 409 },
        );
      }
      if (
        pending.kind !== "approval" &&
        recoveryReview === null &&
        body.message === undefined &&
        answer === undefined
      ) {
        throw new Error("A question interaction requires a message or answer.");
      }
      const message =
        body.recoveryOptionId !== undefined
          ? recoveryOptionLabel(body.recoveryOptionId)
          : body.message ??
        (pending.kind === "approval"
          ? hostedV2Approval
            ? body.decision === "approve_once"
              ? "Approve once"
              : "Decline"
            : body.decision === "approve"
              ? "Approved"
              : "Denied"
          : answer !== undefined
            ? answer
            : JSON.stringify(body.content ?? {}));
      const resumed = await resolveDurableRuntimeInteraction({
        organizationId,
        threadId: params.id,
        userId: session.user.id,
        requestId: pending.requestId,
        eventType: pending.eventType,
        turnId: pending.turnId,
        message,
        ...(pending.kind === "approval"
          ? hostedV2Approval
            ? { decision: body.decision as "decline" | "approve_once" }
            : { approved: body.decision === "approve" }
          : {}),
        ...(body.recoveryOptionId !== undefined
          ? { recoveryOptionId: body.recoveryOptionId }
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
      if (body.decision === undefined) {
        throw new Error("An App interaction requires a decision.");
      }
      if (body.decision !== "approve" && body.decision !== "deny") {
        throw new Error("An App interaction requires approve or deny.");
      }
      await resolveMcpInteraction({
        organizationId,
        threadId: params.id,
        userId: session.user.id,
        checkpointId: pending.sourceCheckpointId,
        ...body,
        decision: body.decision,
      });
    }
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
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
