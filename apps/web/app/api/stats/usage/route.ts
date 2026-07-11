import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

const usageSchema = z.object({
  source: z.string().min(1),
  sourceId: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const payload = usageSchema.parse(await request.json());
    const userId = session.user.id;
    const eventDate = new Date().toISOString().slice(0, 10);

    const [usage] = await knowledgeDb
      .insert(schema.apiUsage)
      .values({
        id: crypto.randomUUID(),
        userId,
        organizationId,
        source: payload.source,
        sourceId: payload.sourceId,
        model: payload.model,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        durationMs: payload.durationMs,
        metadata: payload.metadata ?? {},
        createdAt: new Date(),
      })
      .returning();

    await knowledgeDb
      .insert(schema.usageStats)
      .values({
        id: crypto.randomUUID(),
        date: eventDate,
        userId,
        organizationId,
        source: payload.source,
        model: payload.model ?? "unknown",
        messageCount: 1,
        totalInputTokens: payload.inputTokens ?? 0,
        totalOutputTokens: payload.outputTokens ?? 0,
        totalDurationMs: payload.durationMs ?? 0,
      })
      .onConflictDoUpdate({
        target: [
          schema.usageStats.date,
          schema.usageStats.organizationId,
          schema.usageStats.userId,
          schema.usageStats.source,
          schema.usageStats.model,
        ],
        set: {
          messageCount: sql`${schema.usageStats.messageCount} + 1`,
          totalInputTokens: sql`${schema.usageStats.totalInputTokens} + ${payload.inputTokens ?? 0}`,
          totalOutputTokens: sql`${schema.usageStats.totalOutputTokens} + ${payload.outputTokens ?? 0}`,
          totalDurationMs: sql`${schema.usageStats.totalDurationMs} + ${payload.durationMs ?? 0}`,
        },
      });

    return NextResponse.json(usage, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
