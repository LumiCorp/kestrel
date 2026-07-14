import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { DbThread } from "@/lib/knowledge/db-types";
import { parseUrlElicitation } from "@/lib/mcp/interaction-protocol";

export const MOBILE_API_VERSION = "1";

export function mobileProjectDto(input: {
  project: typeof schema.projects.$inferSelect;
}) {
  return {
    id: input.project.id,
    name: input.project.name,
    description: input.project.description,
    updatedAt: input.project.updatedAt.toISOString(),
  };
}

export async function mobileThreadDtos(threads: DbThread[]) {
  if (threads.length === 0) {
    return [];
  }
  const threadIds = threads.map((thread) => thread.id);
  const rankedMessages = knowledgeDb
    .select({
      threadId: schema.threadMessages.threadId,
      searchText: schema.threadMessages.searchText,
      rank: sql<number>`row_number() over (
        partition by ${schema.threadMessages.threadId}
        order by ${schema.threadMessages.createdAt} desc, ${schema.threadMessages.id} desc
      )`.as("rank"),
    })
    .from(schema.threadMessages)
    .where(inArray(schema.threadMessages.threadId, threadIds))
    .as("ranked_mobile_thread_messages");
  const rankedTurns = knowledgeDb
    .select({
      threadId: schema.threadTurns.threadId,
      status: schema.threadTurns.status,
      rank: sql<number>`row_number() over (
        partition by ${schema.threadTurns.threadId}
        order by ${schema.threadTurns.createdAt} desc, ${schema.threadTurns.id} desc
      )`.as("rank"),
    })
    .from(schema.threadTurns)
    .where(inArray(schema.threadTurns.threadId, threadIds))
    .as("ranked_mobile_thread_turns");
  const projectIds = threads
    .map((thread) => thread.projectId)
    .filter((id): id is string => Boolean(id));
  const [messages, turns, projects] = await Promise.all([
    knowledgeDb
      .select({
        threadId: rankedMessages.threadId,
        searchText: rankedMessages.searchText,
      })
      .from(rankedMessages)
      .where(eq(rankedMessages.rank, 1)),
    knowledgeDb
      .select({
        threadId: rankedTurns.threadId,
        status: rankedTurns.status,
      })
      .from(rankedTurns)
      .where(eq(rankedTurns.rank, 1)),
    projectIds.length > 0
      ? knowledgeDb
          .select({ id: schema.projects.id, name: schema.projects.name })
          .from(schema.projects)
          .where(inArray(schema.projects.id, projectIds))
      : Promise.resolve([]),
  ]);
  const previews = new Map<string, string>();
  for (const message of messages) {
    if (!previews.has(message.threadId)) {
      previews.set(message.threadId, message.searchText);
    }
  }
  const statuses = new Map<string, string>();
  for (const turn of turns) {
    if (!statuses.has(turn.threadId)) {
      statuses.set(turn.threadId, turn.status);
    }
  }
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name])
  );
  return threads.map((thread) => ({
    id: thread.id,
    title: thread.title || "New thread",
    project: thread.projectId
      ? {
          id: thread.projectId,
          name: projectNames.get(thread.projectId) ?? "Project",
        }
      : null,
    preview: previews.get(thread.id) ?? "",
    runStatus: statuses.get(thread.id) ?? null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  }));
}

export function mobileTurnDto(turn: typeof schema.threadTurns.$inferSelect) {
  return {
    id: turn.id,
    threadId: turn.threadId,
    inputMessageId: turn.inputMessageId,
    sequence: turn.sequence,
    status: turn.status,
    failure:
      turn.failureCode || turn.failureMessage
        ? { code: turn.failureCode, message: turn.failureMessage }
        : null,
    cancelRequestedAt: turn.cancelRequestedAt?.toISOString() ?? null,
    startedAt: turn.startedAt?.toISOString() ?? null,
    finishedAt: turn.finishedAt?.toISOString() ?? null,
    createdAt: turn.createdAt.toISOString(),
    updatedAt: turn.updatedAt.toISOString(),
  };
}

const elicitationSchema = z.object({
  message: z.string().min(1).max(2000),
  requestedSchema: z.object({
    properties: z.record(
      z.string(),
      z.object({
        type: z.enum(["string", "number", "integer", "boolean", "array"]),
        title: z.string().max(200).optional(),
        description: z.string().max(500).optional(),
        enum: z.array(z.string().max(200)).max(100).optional(),
        items: z
          .object({ enum: z.array(z.string().max(200)).max(100) })
          .optional(),
      })
    ),
    required: z.array(z.string()).max(100).optional(),
  }),
});

export function mobileInteractionDto(
  interaction: typeof schema.mcpInteractionCheckpoints.$inferSelect
) {
  if (interaction.kind === "sampling") {
    return {
      id: interaction.id,
      kind: "approval" as const,
      title: "Allow this agent request?",
      prompt:
        "The agent requested a protected model operation. Review and allow or deny it.",
      fields: [],
      createdAt: interaction.createdAt.toISOString(),
    };
  }
  const urlRequest = parseUrlElicitation(interaction.requestEnvelope);
  if (urlRequest) {
    return {
      id: interaction.id,
      kind: "approval" as const,
      title: "Allow this external step?",
      prompt: urlRequest.message,
      fields: [],
      createdAt: interaction.createdAt.toISOString(),
    };
  }
  const request = elicitationSchema.safeParse(interaction.requestEnvelope);
  if (!request.success) {
    return {
      id: interaction.id,
      kind: "question" as const,
      title: "Your agent needs an answer",
      prompt: "Review this request in Kestrel One on the web.",
      fields: [],
      createdAt: interaction.createdAt.toISOString(),
    };
  }
  const required = new Set(request.data.requestedSchema.required ?? []);
  return {
    id: interaction.id,
    kind: "question" as const,
    title: "Your agent needs an answer",
    prompt: request.data.message,
    fields: Object.entries(request.data.requestedSchema.properties).map(
      ([name, field]) => ({
        name,
        label: field.title ?? field.description ?? name,
        type: field.enum
          ? ("select" as const)
          : field.type === "array" && field.items?.enum
            ? ("multi_select" as const)
            : field.type === "integer" || field.type === "number"
              ? ("number" as const)
              : field.type === "boolean"
                ? ("boolean" as const)
                : ("text" as const),
        required: required.has(name),
        ...((field.enum ?? field.items?.enum)
          ? { options: field.enum ?? field.items?.enum }
          : {}),
      })
    ),
    createdAt: interaction.createdAt.toISOString(),
  };
}
