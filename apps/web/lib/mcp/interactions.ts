import { generateText, jsonSchema, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getThreadAccessForUser } from "@/lib/threads/store";
import { buildElicitationResponse } from "./interaction-protocol";

const MCP_SAMPLING_PROCESSING_TIMEOUT_MS = 5 * 60_000;

export async function listPendingMcpInteractions(input: {
  organizationId: string;
  threadId: string;
  userId: string;
}) {
  await requireManageAccess(input);
  return knowledgeDb.query.mcpInteractionCheckpoints.findMany({
    where: (table, { and, eq }) =>
      and(eq(table.threadId, input.threadId), eq(table.status, "requested")),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
}

export async function resolveMcpInteraction(input: {
  organizationId: string;
  threadId: string;
  userId: string;
  checkpointId: string;
  decision: "approve" | "deny";
  content?: Record<string, string | number | boolean | string[]> | undefined;
}) {
  await requireManageAccess(input);
  const checkpoint =
    await knowledgeDb.query.mcpInteractionCheckpoints.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.id, input.checkpointId),
          eq(table.threadId, input.threadId),
        ),
    });
  if (!checkpoint) throw new Error("Pending MCP interaction not found.");
  if (checkpoint.status !== "requested") throw interactionConflict();
  const now = new Date();
  let updated;
  if (checkpoint.kind === "sampling" && input.decision === "approve") {
    const processingExpiresAt = new Date(
      now.getTime() + MCP_SAMPLING_PROCESSING_TIMEOUT_MS,
    );
    const claimed = await knowledgeDb.transaction(async (tx) => {
      const [checkpoint] = await tx
        .update(schema.mcpInteractionCheckpoints)
        .set({
          status: "processing",
          resolvedByUserId: input.userId,
          processingStartedAt: now,
          processingExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.mcpInteractionCheckpoints.id, input.checkpointId),
            eq(schema.mcpInteractionCheckpoints.status, "requested"),
          ),
        )
        .returning();
      if (checkpoint) {
        await tx
          .update(schema.threadInteractions)
          .set({
            status: "processing",
            resolvedByUserId: input.userId,
            updatedAt: now,
          })
          .where(
            eq(schema.threadInteractions.sourceCheckpointId, input.checkpointId)
          );
      }
      return checkpoint;
    });
    if (!claimed) throw interactionConflict();
    try {
      const responseEnvelope = await executeApprovedSampling(
        checkpoint.requestEnvelope,
        processingExpiresAt,
      );
      updated = await knowledgeDb.transaction(async (tx) => {
        const completedAt = new Date();
        const [completed] = await tx
          .update(schema.mcpInteractionCheckpoints)
          .set({
            status: "completed",
            responseEnvelope,
            resolvedAt: completedAt,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(schema.mcpInteractionCheckpoints.id, input.checkpointId),
              eq(schema.mcpInteractionCheckpoints.status, "processing"),
            ),
          )
          .returning();
        if (completed) {
          await tx
            .update(schema.threadInteractions)
            .set({
              status: "resolved",
              responseEnvelope,
              resolvedByUserId: input.userId,
              resolvedAt: completedAt,
              updatedAt: completedAt,
            })
            .where(
              eq(
                schema.threadInteractions.sourceCheckpointId,
                input.checkpointId
              )
            );
        }
        return completed;
      });
      if (!updated) throw interactionConflict();
    } catch (error) {
      if (
        error instanceof Error &&
        (error as Error & { code?: string }).code === "MCP_INTERACTION_CONFLICT"
      ) {
        throw error;
      }
      const failureCode =
        error instanceof Error &&
        (error as Error & { code?: string }).code === "MCP_SAMPLING_TIMEOUT"
          ? "MCP_SAMPLING_TIMEOUT"
          : "MCP_SAMPLING_FAILED";
      const failureMessage =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "MCP sampling failed.";
      const failedWhileOwned = await knowledgeDb.transaction(
        async (transaction) => {
          const failedCheckpoints = await transaction
            .update(schema.mcpInteractionCheckpoints)
            .set({
              status: "failed",
              failureCode,
              failureMessage,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.mcpInteractionCheckpoints.id, input.checkpointId),
                eq(schema.mcpInteractionCheckpoints.status, "processing"),
              ),
            )
            .returning({ id: schema.mcpInteractionCheckpoints.id });
          if (failedCheckpoints.length === 0) return false;
          await transaction
            .update(schema.threadInteractions)
            .set({
              status: "failed",
              resolvedByUserId: input.userId,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              eq(
                schema.threadInteractions.sourceCheckpointId,
                input.checkpointId
              )
            );
          await transaction
            .update(schema.mcpInvocations)
            .set({
              status: "failed",
              errorCode: failureCode,
              errorMessage: failureMessage,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.mcpInvocations.id, checkpoint.invocationId));
          return true;
        },
      );
      if (!failedWhileOwned) throw interactionConflict();
      throw error;
    }
  } else {
    const status = input.decision === "deny" ? "denied" : "completed";
    const responseEnvelope =
      checkpoint.kind === "elicitation"
        ? buildElicitationResponse({
            requestEnvelope: checkpoint.requestEnvelope,
            decision: input.decision,
            content: input.content,
          })
        : null;
    updated = await knowledgeDb.transaction(async (tx) => {
      const [resolved] = await tx
        .update(schema.mcpInteractionCheckpoints)
        .set({
          status,
          responseEnvelope,
          resolvedByUserId: input.userId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.mcpInteractionCheckpoints.id, input.checkpointId),
            eq(schema.mcpInteractionCheckpoints.status, "requested"),
          ),
        )
        .returning();
      if (resolved) {
        await tx
          .update(schema.threadInteractions)
          .set({
            status: input.decision === "deny" ? "cancelled" : "resolved",
            responseEnvelope,
            resolvedByUserId: input.userId,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            eq(schema.threadInteractions.sourceCheckpointId, input.checkpointId)
          );
      }
      return resolved;
    });
    if (!updated) throw interactionConflict();
  }
  const status = updated.status;
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.userId,
    category: "mcp",
    action: `mcp.interaction.${status}`,
    targetType: "mcp_interaction_checkpoint",
    targetId: updated.id,
    message: `${checkpoint.kind} MCP interaction ${status}.`,
    metadata: {
      threadId: input.threadId,
      kind: checkpoint.kind,
      decision: input.decision,
    },
  });
  return updated;
}

function interactionConflict() {
  return Object.assign(new Error("MCP interaction was already claimed."), {
    code: "MCP_INTERACTION_CONFLICT",
  });
}

async function executeApprovedSampling(
  value: unknown,
  processingExpiresAt: Date,
) {
  const request = z
    .object({
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.unknown(),
        }),
      ),
      systemPrompt: z.string().optional(),
      maxTokens: z.number().int().positive().max(32_768),
      tools: z
        .array(
          z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            inputSchema: z.record(z.string(), z.unknown()),
          }),
        )
        .optional(),
      toolChoice: z
        .object({ mode: z.enum(["auto", "required", "none"]).optional() })
        .optional(),
    })
    .parse(value);
  const resolved = await resolveRequiredLanguageModel({ surface: "chat" });
  const prompt = request.messages
    .map((message) => `${message.role}: ${extractText(message.content)}`)
    .join("\n");
  const controller = new AbortController();
  const remainingMs = Math.max(0, processingExpiresAt.getTime() - Date.now());
  const timeout =
    remainingMs === 0
      ? (controller.abort(), undefined)
      : setTimeout(() => controller.abort(), remainingMs);
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: resolved.model,
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      prompt,
      maxOutputTokens: request.maxTokens,
      abortSignal: controller.signal,
      ...(request.tools?.length
        ? {
            tools: Object.fromEntries(
              request.tools.map((definition) => [
                definition.name,
                tool({
                  description: definition.description,
                  inputSchema: jsonSchema<Record<string, unknown>>(
                    definition.inputSchema,
                  ),
                }),
              ]),
            ),
            toolChoice: request.toolChoice?.mode ?? "auto",
          }
        : {}),
    });
  } catch (error) {
    if (controller.signal.aborted) throw samplingTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const content = request.tools?.length
    ? [
        ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
        ...result.toolCalls.map((call) => ({
          type: "tool_use" as const,
          name: call.toolName,
          id: call.toolCallId,
          input: z.record(z.string(), z.unknown()).parse(call.input),
        })),
      ]
    : { type: "text" as const, text: result.text };
  return {
    role: "assistant",
    content,
    model: resolved.resolvedModelId,
    stopReason:
      result.toolCalls.length > 0
        ? "toolUse"
        : result.finishReason === "length"
          ? "maxTokens"
          : "endTurn",
  };
}

function samplingTimeoutError() {
  return Object.assign(
    new Error("MCP sampling exceeded its processing deadline."),
    {
      code: "MCP_SAMPLING_TIMEOUT",
    },
  );
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.type === "tool_use") {
    return `[tool_use ${String(record.name ?? "unknown")}] ${JSON.stringify(record.input ?? {})}`;
  }
  if (record.type === "tool_result") {
    return `[tool_result ${String(record.toolUseId ?? "unknown")}] ${extractText(record.content)}`;
  }
  return `[${typeof record.type === "string" ? record.type : "content"}]`;
}

async function requireManageAccess(input: {
  organizationId: string;
  threadId: string;
  userId: string;
}) {
  const access = await getThreadAccessForUser(
    input.threadId,
    input.userId,
    input.organizationId,
  );
  if (!access?.canManage) throw new Error("Thread not found.");
  return access;
}
