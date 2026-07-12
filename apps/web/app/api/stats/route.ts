import { and, eq, gte, lt } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await requireAdminOrganization();

    const days = Math.min(
      Math.max(Number(request.nextUrl.searchParams.get("days")) || 30, 1),
      365
    );
    const sourcesFilter =
      request.nextUrl.searchParams.get("sources")?.split(",").filter(Boolean) ??
      null;
    const modelsFilter =
      request.nextUrl.searchParams.get("models")?.split(",").filter(Boolean) ??
      null;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);

    const prevEndDate = new Date(startDate);
    const prevStartDate = new Date(startDate);
    prevStartDate.setDate(prevStartDate.getDate() - days);

    const [messagesWithStats, prevMessagesWithStats, apiUsageData] =
      await Promise.all([
        knowledgeDb
          .select({
            threadId: schema.threadMessages.threadId,
            model: schema.threadMessages.model,
            inputTokens: schema.threadMessages.inputTokens,
            outputTokens: schema.threadMessages.outputTokens,
            durationMs: schema.threadMessages.durationMs,
            feedback: schema.threadMessages.feedback,
            createdAt: schema.threadMessages.createdAt,
          })
          .from(schema.threadMessages)
          .where(
            and(
              eq(schema.threadMessages.role, "assistant"),
              gte(schema.threadMessages.createdAt, startDate)
            )
          ),
        knowledgeDb
          .select({
            threadId: schema.threadMessages.threadId,
            inputTokens: schema.threadMessages.inputTokens,
            outputTokens: schema.threadMessages.outputTokens,
          })
          .from(schema.threadMessages)
          .where(
            and(
              eq(schema.threadMessages.role, "assistant"),
              gte(schema.threadMessages.createdAt, prevStartDate),
              lt(schema.threadMessages.createdAt, prevEndDate)
            )
          ),
        knowledgeDb
          .select({
            source: schema.apiUsage.source,
            model: schema.apiUsage.model,
            inputTokens: schema.apiUsage.inputTokens,
            outputTokens: schema.apiUsage.outputTokens,
            durationMs: schema.apiUsage.durationMs,
            createdAt: schema.apiUsage.createdAt,
          })
          .from(schema.apiUsage)
          .where(
            and(
              eq(schema.apiUsage.organizationId, organizationId),
              gte(schema.apiUsage.createdAt, startDate)
            )
          ),
      ]);

    const organizationChatIds = await knowledgeDb
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.organizationId, organizationId));

    const activeChatIds = new Set(organizationChatIds.map((chat) => chat.id));

    const filteredMessages = messagesWithStats.filter((message) => {
      if (!activeChatIds.has(message.threadId)) {
        return false;
      }
      if (sourcesFilter && !sourcesFilter.includes("web")) {
        return false;
      }
      if (modelsFilter && !modelsFilter.includes(message.model ?? "unknown")) {
        return false;
      }
      return true;
    });

    const filteredPreviousMessages = prevMessagesWithStats.filter((message) =>
      activeChatIds.has(message.threadId)
    );

    const filteredUsage = apiUsageData.filter((usage) => {
      if (sourcesFilter && !sourcesFilter.includes(usage.source)) {
        return false;
      }
      if (modelsFilter && !modelsFilter.includes(usage.model ?? "unknown")) {
        return false;
      }
      return true;
    });

    const totalMessages = filteredMessages.length;
    const previousMessages = filteredPreviousMessages.length;

    const totals = filteredMessages.reduce(
      (acc, message) => {
        acc.inputTokens += message.inputTokens ?? 0;
        acc.outputTokens += message.outputTokens ?? 0;
        acc.durationMs += message.durationMs ?? 0;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, durationMs: 0 }
    );

    const usageTotals = filteredUsage.reduce(
      (acc, usage) => {
        acc.inputTokens += usage.inputTokens ?? 0;
        acc.outputTokens += usage.outputTokens ?? 0;
        acc.durationMs += usage.durationMs ?? 0;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, durationMs: 0 }
    );

    const availableSources = Array.from(
      new Set(["web", ...apiUsageData.map((usage) => usage.source)])
    ).sort();
    const availableModels = Array.from(
      new Set([
        ...messagesWithStats.map((message) => message.model).filter(Boolean),
        ...apiUsageData.map((usage) => usage.model).filter(Boolean),
      ])
    ).sort();

    return NextResponse.json({
      days,
      totalMessages,
      previousMessages,
      trends: {
        messagesDelta: totalMessages - previousMessages,
      },
      totals: {
        totalInputTokens: totals.inputTokens + usageTotals.inputTokens,
        totalOutputTokens: totals.outputTokens + usageTotals.outputTokens,
        totalDurationMs: totals.durationMs + usageTotals.durationMs,
      },
      availableSources,
      availableModels,
      bySource: filteredUsage,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
