import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@/lib/knowledge/db";
import { createDurableThreadTurnInTransaction } from "@/lib/turns/store";
import { withLockedProjectPromptScheduleRun } from "./store";

export function formatProjectPromptScheduleRunTitle(input: {
  title: string;
  trigger: "scheduled" | "test";
  scheduledFor: Date;
  timeZone: string;
}) {
  const occurrence = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timeZone,
  }).format(input.scheduledFor);
  return `${input.title} · ${input.trigger === "test" ? "Test · " : ""}${occurrence}`;
}

export async function materializeProjectPromptScheduleRun(runId: string) {
  return withLockedProjectPromptScheduleRun(
    runId,
    async ({ tx, current, cancel, complete }) => {
      if (current.run.status === "materialized") {
        return current.run.turnId;
      }
      if (current.run.status !== "queued") return null;
      if (current.run.trigger === "scheduled" && !current.schedule.enabled) {
        await cancel("manual");
        return null;
      }
      if (!current.schedule.createdByUserId) {
        if (current.run.trigger === "test") {
          throw Object.assign(
            new Error("The schedule creator is no longer available."),
            { code: "SCHEDULE_CREATOR_UNAVAILABLE" },
          );
        }
        await cancel("creator_access_lost");
        return null;
      }
      if (current.projectArchivedAt) {
        if (current.run.trigger === "test") {
          throw Object.assign(
            new Error("Restore the Project before testing this schedule."),
            { code: "SCHEDULE_PROJECT_ARCHIVED" },
          );
        }
        await cancel("project_archived");
        return null;
      }
      const creatorUserId = current.schedule.createdByUserId;
      const [creatorMembership] = await tx
        .select({ id: schema.members.id })
        .from(schema.members)
        .innerJoin(
          schema.projectMembers,
          and(
            eq(
              schema.projectMembers.organizationMemberId,
              schema.members.id,
            ),
            eq(
              schema.projectMembers.projectId,
              current.schedule.projectId,
            ),
          ),
        )
        .where(
          and(
            eq(
              schema.members.organizationId,
              current.schedule.organizationId,
            ),
            eq(schema.members.userId, creatorUserId),
          ),
        )
        .limit(1);
      if (!creatorMembership) {
        if (current.run.trigger === "test") {
          throw Object.assign(
            new Error("The schedule creator no longer has Project access."),
            { code: "SCHEDULE_CREATOR_ACCESS_LOST" },
          );
        }
        await cancel("creator_access_lost");
        return null;
      }
      const [projectContext] = await tx
        .select({ id: schema.projectContextRevisions.id })
        .from(schema.projectContextRevisions)
        .where(
          and(
            eq(
              schema.projectContextRevisions.projectId,
              current.schedule.projectId,
            ),
            eq(
              schema.projectContextRevisions.revision,
              current.projectCurrentContextRevision,
            ),
          ),
        )
        .limit(1);
      if (!projectContext) {
        throw Object.assign(new Error("Project context is unavailable."), {
          code: "SCHEDULE_PROJECT_CONTEXT_UNAVAILABLE",
        });
      }
      const [environment] = await tx
        .select({ id: schema.environments.id })
        .from(schema.environments)
        .where(
          and(
            eq(schema.environments.id, current.projectEnvironmentId),
            eq(
              schema.environments.organizationId,
              current.schedule.organizationId,
            ),
            isNull(schema.environments.archivedAt),
          ),
        )
        .limit(1);
      if (!environment) {
        throw Object.assign(new Error("Project Environment is unavailable."), {
          code: "SCHEDULE_ENVIRONMENT_UNAVAILABLE",
        });
      }
      const threadId = current.run.threadId;
      if (!threadId) {
        throw Object.assign(
          new Error("Scheduled Thread identity is unavailable."),
          { code: "SCHEDULE_THREAD_ID_UNAVAILABLE" },
        );
      }
      let [thread] = await tx
        .select()
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.id, threadId),
            eq(
              schema.threads.organizationId,
              current.schedule.organizationId,
            ),
          ),
        )
        .limit(1);
      if (!thread) {
        const now = new Date();
        [thread] = await tx
          .insert(schema.threads)
          .values({
            id: threadId,
            createdByUserId: creatorUserId,
            organizationId: current.schedule.organizationId,
            projectId: current.schedule.projectId,
            mode: "chat",
            origin: "web",
            workspaceMode: "primary",
            activeStreamId: null,
            title: formatProjectPromptScheduleRunTitle({
              title: current.run.titleSnapshot,
              trigger: current.run.trigger,
              scheduledFor: current.run.scheduledFor,
              timeZone: current.schedule.timeZone,
            }),
            isPublic: false,
            shareToken: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (thread) {
          await tx.insert(schema.projectAuditEvents).values({
            id: crypto.randomUUID(),
            projectId: current.schedule.projectId,
            actorUserId: creatorUserId,
            action: "thread.created",
            targetType: "thread",
            targetId: thread.id,
            createdAt: now,
          });
        }
      }
      if (!thread) {
        throw Object.assign(new Error("Scheduled Thread creation failed."), {
          code: "SCHEDULE_THREAD_CREATION_FAILED",
        });
      }
      if (
        thread.projectId !== current.schedule.projectId ||
        thread.createdByUserId !== creatorUserId ||
        thread.mode !== "chat" ||
        thread.origin !== "web" ||
        thread.workspaceMode !== "primary"
      ) {
        throw Object.assign(
          new Error("Scheduled Thread identity is already in use."),
          { code: "SCHEDULE_THREAD_ID_CONFLICT" },
        );
      }
      const durable = await createDurableThreadTurnInTransaction(tx, {
        threadId: thread.id,
        organizationId: current.schedule.organizationId,
        authorUserId: creatorUserId,
        messageId: current.run.messageId,
        messageParts: [{ type: "text", text: current.run.promptSnapshot }],
        idempotencyKey: `schedule-run:${current.run.id}`,
        requestedEnvironmentId: environment.id,
        projectContextRevisionId: projectContext.id,
        requestedModelId: current.run.modelIdSnapshot,
        requestedInteractionMode: "build",
        source: "web",
      });
      await complete(durable.turn.id);
      return durable.shouldDispatch
        ? (durable.dispatchTurnId ?? durable.turn.id)
        : durable.turn.id;
    },
  );
}
