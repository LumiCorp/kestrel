import "server-only";

import { and, eq, max } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const INCIDENT_THREAD_ID = "36dd83cc-5dc8-4343-914a-f2bd71026b60";
const FAILURE_CODE = "HISTORICAL_HOSTED_APP_GRANT_MISSING";
const INTERNAL_FAILURE_MESSAGE =
  "The historical runner approval could not be authorized because no hosted App grant was recorded.";
const PUBLIC_FAILURE_MESSAGE =
  "Authorization failed — operation not executed. Request a fresh approval.";

type ReconciliationExecutor = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

function isAffectedEmailApproval(
  interaction: typeof schema.threadInteractions.$inferSelect,
) {
  const approval = interaction.requestEnvelope.approval;
  return (
    interaction.source === "runtime" &&
    interaction.kind === "approval" &&
    interaction.status === "resolved" &&
    interaction.responseEnvelope !== null &&
    typeof interaction.responseEnvelope.approved === "boolean" &&
    approval !== null &&
    typeof approval === "object" &&
    (approval as Record<string, unknown>).toolName === "kestrel_one.email_send"
  );
}

function failedPresentation(
  parts: unknown,
  requestId: string,
  approved: boolean,
) {
  if (!Array.isArray(parts)) return parts;
  return parts.map((part) => {
    if (!(part && typeof part === "object" && !Array.isArray(part))) return part;
    const record = part as Record<string, unknown>;
    const data =
      record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : null;
    if (
      record.type !== "data-kestrel-interaction" ||
      data?.requestId !== requestId
    ) {
      return part;
    }
    return {
      ...record,
      data: {
        ...data,
        status: "failed",
        approvalOutcome: {
          decision: approved ? "approved" : "denied",
          authorizationState: "failed",
          effectState: "not_started",
          failureCode: FAILURE_CODE,
          publicMessage: PUBLIC_FAILURE_MESSAGE,
          retryEligible: false,
        },
      },
    };
  });
}

async function inspectIncident(tx: ReconciliationExecutor) {
  const [thread, interactions, deliveries, approvals] = await Promise.all([
    tx.query.threads.findFirst({
      where: eq(schema.threads.id, INCIDENT_THREAD_ID),
      columns: { id: true, organizationId: true },
    }),
    tx.query.threadInteractions.findMany({
      where: eq(schema.threadInteractions.threadId, INCIDENT_THREAD_ID),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    }),
    tx.query.organizationEmailDeliveries.findMany({
      where: eq(schema.organizationEmailDeliveries.threadId, INCIDENT_THREAD_ID),
      columns: { id: true, status: true },
    }),
    tx.query.appOperationApprovals.findMany({
      where: eq(schema.appOperationApprovals.threadId, INCIDENT_THREAD_ID),
      columns: { id: true, status: true },
    }),
  ]);
  const affected = interactions.filter(isAffectedEmailApproval);
  if (!thread) throw new Error("INCIDENT_THREAD_NOT_FOUND");
  if (affected.length !== 3) {
    throw new Error(`INCIDENT_INTERACTION_COUNT_MISMATCH:${affected.length}`);
  }
  if (deliveries.length !== 0) {
    throw new Error(`INCIDENT_EMAIL_DELIVERIES_PRESENT:${deliveries.length}`);
  }
  if (approvals.length !== 0) {
    throw new Error(`INCIDENT_APP_APPROVALS_PRESENT:${approvals.length}`);
  }
  return { thread, affected };
}

export async function reconcileHostedApprovalIncident(apply: boolean) {
  return knowledgeDb.transaction(async (tx) => {
    const { affected } = await inspectIncident(tx);
    if (!apply) {
      return {
        mode: "dry-run" as const,
        threadId: INCIDENT_THREAD_ID,
        interactionIds: affected.map((interaction) => interaction.id),
      };
    }
    const now = new Date();
    for (const interaction of affected) {
      const [locked] = await tx
        .select()
        .from(schema.threadInteractions)
        .where(
          and(
            eq(schema.threadInteractions.id, interaction.id),
            eq(schema.threadInteractions.status, "resolved"),
          ),
        )
        .limit(1)
        .for("update");
      if (!locked) throw new Error("INCIDENT_INTERACTION_CHANGED");
      await tx
        .update(schema.threadInteractions)
        .set({
          status: "failed",
          responseFailureCode: FAILURE_CODE,
          responseFailureMessage: INTERNAL_FAILURE_MESSAGE,
          effectStatus: "not_started",
          responseRetryable: false,
          updatedAt: now,
        })
        .where(eq(schema.threadInteractions.id, locked.id));
      if (locked.assistantMessageId) {
        const message = await tx.query.threadMessages.findFirst({
          where: eq(schema.threadMessages.id, locked.assistantMessageId),
          columns: { parts: true },
        });
        if (!message) throw new Error("INCIDENT_PRESENTATION_MISSING");
        await tx
          .update(schema.threadMessages)
          .set({
            parts: failedPresentation(
              message.parts,
              locked.requestId,
              locked.responseEnvelope?.approved === true,
            ),
          })
          .where(eq(schema.threadMessages.id, locked.assistantMessageId));
      }
      if (!locked.turnId) throw new Error("INCIDENT_TURN_MISSING");
      await tx
        .select({ id: schema.threadTurns.id })
        .from(schema.threadTurns)
        .where(eq(schema.threadTurns.id, locked.turnId))
        .limit(1)
        .for("update");
      const [latest] = await tx
        .select({ sequence: max(schema.threadTurnEvents.sequence) })
        .from(schema.threadTurnEvents)
        .where(eq(schema.threadTurnEvents.turnId, locked.turnId));
      await tx.insert(schema.threadTurnEvents).values({
        id: crypto.randomUUID(),
        turnId: locked.turnId,
        sequence: (latest?.sequence ?? 0) + 1,
        type: "interaction.authorization_failed",
        data: {
          requestId: locked.requestId,
          failureCode: FAILURE_CODE,
          effectStatus: "not_started",
          retryable: false,
          reconciliation: "hosted-approval-incident-36dd83cc",
        },
      });
    }
    return {
      mode: "apply" as const,
      threadId: INCIDENT_THREAD_ID,
      interactionIds: affected.map((interaction) => interaction.id),
    };
  });
}

const apply = process.argv.slice(2).includes("--apply");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--apply");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`);
}
console.log(JSON.stringify(await reconcileHostedApprovalIncident(apply)));
