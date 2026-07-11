import { and, eq, gte, isNotNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const userId = session.user.id;
    const days = Math.min(
      Math.max(Number(request.nextUrl.searchParams.get("days")) || 30, 1),
      365
    );

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateKey = startDate.toISOString().slice(0, 10);

    const [messageRows, usageRows] = await Promise.all([
      knowledgeDb
        .select({
          model: schema.knowledgeMessages.model,
          inputTokens: schema.knowledgeMessages.inputTokens,
          outputTokens: schema.knowledgeMessages.outputTokens,
          durationMs: schema.knowledgeMessages.durationMs,
          createdAt: schema.knowledgeMessages.createdAt,
        })
        .from(schema.knowledgeMessages)
        .innerJoin(
          schema.knowledgeChats,
          eq(schema.knowledgeMessages.chatId, schema.knowledgeChats.id)
        )
        .where(
          and(
            eq(schema.knowledgeChats.userId, userId),
            eq(schema.knowledgeChats.organizationId, organizationId),
            eq(schema.knowledgeMessages.role, "assistant"),
            gte(schema.knowledgeMessages.createdAt, startDate),
            isNotNull(schema.knowledgeMessages.model)
          )
        ),
      knowledgeDb
        .select({
          source: schema.usageStats.source,
          model: schema.usageStats.model,
          messageCount: schema.usageStats.messageCount,
          totalInputTokens: schema.usageStats.totalInputTokens,
          totalOutputTokens: schema.usageStats.totalOutputTokens,
          totalDurationMs: schema.usageStats.totalDurationMs,
        })
        .from(schema.usageStats)
        .where(
          and(
            eq(schema.usageStats.userId, userId),
            eq(schema.usageStats.organizationId, organizationId),
            gte(schema.usageStats.date, startDateKey)
          )
        ),
    ]);

    const totalMessages = messageRows.length;
    const totals = messageRows.reduce(
      (acc, row) => {
        acc.inputTokens += row.inputTokens ?? 0;
        acc.outputTokens += row.outputTokens ?? 0;
        acc.durationMs += row.durationMs ?? 0;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, durationMs: 0 }
    );

    const usageTotals = usageRows.reduce(
      (acc, row) => {
        acc.messages += row.messageCount ?? 0;
        acc.inputTokens += row.totalInputTokens ?? 0;
        acc.outputTokens += row.totalOutputTokens ?? 0;
        acc.durationMs += row.totalDurationMs ?? 0;
        return acc;
      },
      { messages: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }
    );

    return NextResponse.json({
      userId,
      organizationId,
      days,
      totalMessages,
      totalInputTokens: totals.inputTokens + usageTotals.inputTokens,
      totalOutputTokens: totals.outputTokens + usageTotals.outputTokens,
      totalDurationMs: totals.durationMs + usageTotals.durationMs,
      usageEvents: usageTotals.messages,
      models: Array.from(
        new Set([
          ...messageRows.map((row) => row.model).filter(Boolean),
          ...usageRows.map((row) => row.model).filter(Boolean),
        ])
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
