import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { normalizeMailbox, parseMailboxFields } from "./mailboxes";

export type EmailDeliveryReceiptState =
  | "queued"
  | "hydrating"
  | "admitted"
  | "materialized"
  | "rejected"
  | "failed";

export type EmailDeliveryReceiptProjection = {
  id: string;
  state: EmailDeliveryReceiptState;
  reservedThreadId: string;
  reservedMessageId: string;
  reservedTurnId: string;
};

export class EmailDeliveryReceiptConflictError extends Error {
  constructor() {
    super("Conflicting delivery receipt identities require operator review.");
    this.name = "EmailDeliveryReceiptConflictError";
  }
}

export class EmailDeliveryReceiptUnavailableError extends Error {
  constructor() {
    super("Email delivery receipt authority is unavailable.");
    this.name = "EmailDeliveryReceiptUnavailableError";
  }
}

export async function createOrFindQueuedEmailDeliveryReceipt(input: {
  organizationId: string;
  receivingConnectionId: string;
  svixId: string;
  resendEmailId: string;
  eventAt: Date;
  claimedFrom: string;
  toMailboxes: string[];
  ccMailboxes: string[];
  bccMailboxes: string[];
  receivedForMailboxes: string[];
  subject: string;
}): Promise<{ receipt: EmailDeliveryReceiptProjection; created: boolean }> {
  return knowledgeDb.transaction(async (transaction) => {
    const [organization] = await transaction
      .select({ lifecycleState: schema.organizations.lifecycleState })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, input.organizationId))
      .for("update");
    if (organization?.lifecycleState !== "active") {
      throw new EmailDeliveryReceiptUnavailableError();
    }
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:email-receipt:${input.receivingConnectionId}`}, 0))`,
    );

    const existing = await transaction
      .select({
        id: schema.emailDeliveryReceipts.id,
        resendEmailId: schema.emailDeliveryReceipts.resendEmailId,
        state: schema.emailDeliveryReceipts.state,
        svixId: schema.emailDeliveryReceipts.svixId,
        reservedThreadId: schema.emailDeliveryReceipts.reservedThreadId,
        reservedMessageId: schema.emailDeliveryReceipts.reservedMessageId,
        reservedTurnId: schema.emailDeliveryReceipts.reservedTurnId,
      })
      .from(schema.emailDeliveryReceipts)
      .where(
        and(
          eq(
            schema.emailDeliveryReceipts.receivingConnectionId,
            input.receivingConnectionId,
          ),
          or(
            eq(schema.emailDeliveryReceipts.svixId, input.svixId),
            eq(
              schema.emailDeliveryReceipts.resendEmailId,
              input.resendEmailId,
            ),
          ),
        ),
      );
    if (existing.length > 1) {
      throw new EmailDeliveryReceiptConflictError();
    }
    const prior = existing[0];
    if (prior) {
      if (
        prior.svixId === input.svixId &&
        prior.resendEmailId !== input.resendEmailId
      ) {
        throw new EmailDeliveryReceiptConflictError();
      }
      return {
        receipt: {
          id: prior.id,
          state: prior.state,
          reservedThreadId: prior.reservedThreadId,
          reservedMessageId: prior.reservedMessageId,
          reservedTurnId: prior.reservedTurnId,
        },
        created: false,
      };
    }

    const receipt: EmailDeliveryReceiptProjection = {
      id: randomUUID(),
      state: "queued",
      reservedThreadId: randomUUID(),
      reservedMessageId: randomUUID(),
      reservedTurnId: randomUUID(),
    };
    const trigger = await resolveIngressReceiptTrigger(transaction, input);
    await transaction.insert(schema.emailDeliveryReceipts).values({
      ...receipt,
      organizationId: input.organizationId,
      receivingConnectionId: input.receivingConnectionId,
      svixId: input.svixId,
      resendEmailId: input.resendEmailId,
      eventAt: input.eventAt,
      ...(trigger
        ? {
            triggerOrganizationId: trigger.organizationId,
            triggerId: trigger.id,
            triggerRevision: trigger.revision,
          }
        : {}),
      claimedFrom: input.claimedFrom,
      toMailboxes: input.toMailboxes,
      ccMailboxes: input.ccMailboxes,
      bccMailboxes: input.bccMailboxes,
      receivedForMailboxes: input.receivedForMailboxes,
      subject: input.subject,
    });
    return { receipt, created: true };
  });
}

async function resolveIngressReceiptTrigger(
  transaction: Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0],
  input: Pick<
    Parameters<typeof createOrFindQueuedEmailDeliveryReceipt>[0],
    "organizationId" | "toMailboxes" | "ccMailboxes" | "bccMailboxes"
  >,
) {
  let recipients: Set<string>;
  try {
    recipients = new Set([
      ...parseMailboxFields(input.toMailboxes),
      ...parseMailboxFields(input.ccMailboxes),
      ...parseMailboxFields(input.bccMailboxes),
    ]);
  } catch {
    // Hydration remains the authoritative mailbox validation and trigger
    // resolution path. A malformed ingress address must not block durable
    // receipt creation just because it cannot be projected to a Trigger.
    return null;
  }
  const triggers = await transaction
    .select({
      id: schema.projectEmailTriggers.id,
      organizationId: schema.projectEmailTriggers.organizationId,
      revision: schema.projectEmailTriggers.revision,
      addressLocalPart: schema.projectEmailTriggers.addressLocalPart,
      addressDomain: schema.projectEmailTriggers.addressDomain,
    })
    .from(schema.projectEmailTriggers)
    .where(eq(schema.projectEmailTriggers.organizationId, input.organizationId));
  const addressed = triggers.filter((trigger) =>
    recipients.has(
      normalizeMailbox(trigger.addressLocalPart, trigger.addressDomain),
    ),
  );
  return addressed.length === 1 ? addressed[0] : null;
}

export async function listDispatchableEmailDeliveryReceiptIds() {
  const rows = await knowledgeDb
    .select({ id: schema.emailDeliveryReceipts.id })
    .from(schema.emailDeliveryReceipts)
    .where(inArray(schema.emailDeliveryReceipts.state, ["queued", "hydrating", "admitted"]))
    .orderBy(asc(schema.emailDeliveryReceipts.createdAt))
    .limit(100);
  return rows.map(({ id }) => id);
}

export async function readEmailDeliveryReceiptState(receiptId: string) {
  return knowledgeDb.query.emailDeliveryReceipts.findFirst({
    columns: { id: true, state: true },
    where: eq(schema.emailDeliveryReceipts.id, receiptId),
  });
}
