import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import emailAddresses from "email-addresses";
import sanitizeHtml from "sanitize-html";
import { decryptReceivingApiKey } from "@/lib/email/receiving-config";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  EMAIL_ATTACHMENT_FILENAME_MAX_LENGTH,
  EMAIL_ATTACHMENT_MAX_COUNT,
  EMAIL_CONTENT_ID_MAX_LENGTH,
  EMAIL_DISPOSITION_MAX_LENGTH,
  EMAIL_MAILBOX_LIST_MAX_COUNT,
  EMAIL_MAILBOX_MAX_LENGTH,
  EMAIL_MEDIA_TYPE_MAX_LENGTH,
  EMAIL_MODEL_VISIBLE_MAX_BYTES,
  EMAIL_SUBJECT_MAX_LENGTH,
} from "./bounds";
import {
  EmailReceiptProviderError,
  type ReceivedEmailAttachment,
  type ReceivedEmailHydration,
  type ReceivedEmailProvider,
  ResendReceivedEmailProvider,
} from "./provider";

export type EmailReceiptTerminalReason =
  | "EMAIL_RECEIPT_PROVIDER_PERMANENT"
  | "EMAIL_RECEIPT_PROVIDER_RESPONSE_INVALID"
  | "EMAIL_RECEIPT_CONNECTION_UNAVAILABLE"
  | "EMAIL_RECEIPT_ADDRESS_INVALID"
  | "EMAIL_RECEIPT_TRIGGER_NOT_FOUND"
  | "EMAIL_RECEIPT_TRIGGER_AMBIGUOUS"
  | "EMAIL_RECEIPT_TRIGGER_DISABLED"
  | "EMAIL_RECEIPT_TRIGGER_CHANGED"
  | "EMAIL_RECEIPT_CLAIMED_FROM_FILTER_INVALID"
  | "EMAIL_RECEIPT_CLAIMED_FROM_MISMATCH"
  | "EMAIL_RECEIPT_BODY_UNUSABLE"
  | "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED";

type TerminalState = "rejected" | "failed";
type HydrationTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

class EmailReceiptDispositionError extends Error {
  constructor(
    readonly state: TerminalState,
    readonly reason: EmailReceiptTerminalReason,
    readonly trigger?: {
      id: string;
      organizationId: string;
      revision: number;
    },
  ) {
    super(reason);
    this.name = "EmailReceiptDispositionError";
  }
}

type ClaimedReceipt = {
  id: string;
  organizationId: string;
  resendEmailId: string;
  encryptedApiKey: string;
};

type ResolvedTrigger = {
  id: string;
  organizationId: string;
  addressLocalPart: string;
  addressDomain: string;
  claimedFromFilter: string | null;
  revision: number;
};

export type AdmittedEmailEnvelope = {
  receiptId: string;
  claimedFrom: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  body: string;
  attachments: Array<{
    id: string;
    order: number;
    filename: string | null;
    declaredMediaType: string;
    sizeBytes: number;
    disposition: string | null;
    contentId: string | null;
  }>;
};

export async function processEmailDeliveryReceipt(
  receiptId: string,
  input: { provider?: ReceivedEmailProvider; env?: NodeJS.ProcessEnv } = {},
) {
  const claimed = await claimReceiptForHydration(receiptId);
  if (!claimed) return { outcome: "terminal_or_unavailable" as const };

  let apiKey: string;
  try {
    apiKey = decryptReceivingApiKey({
      organizationId: claimed.organizationId,
      encryptedApiKey: claimed.encryptedApiKey,
      env: input.env,
    });
  } catch {
    return await finishEmailReceipt(
      claimed.id,
      "failed",
      "EMAIL_RECEIPT_PROVIDER_PERMANENT",
    );
  }

  let hydrated: ReceivedEmailHydration;
  try {
    hydrated = await (
      input.provider ?? new ResendReceivedEmailProvider()
    ).retrieve(apiKey, claimed.resendEmailId);
  } catch (error) {
    if (error instanceof EmailReceiptProviderError) {
      if (error.retryable) throw error;
      return await finishEmailReceipt(
        claimed.id,
        providerFailureState(error.code),
        providerFailureReason(error.code),
      );
    }
    throw error;
  }

  try {
    const normalized = normalizeReceivedEmail(hydrated);
    const trigger = await resolveEmailTrigger(
      claimed.organizationId,
      normalized.recipientSet,
    );
    if (trigger.claimedFromFilter) {
      let filter: string;
      try {
        filter = parseExactlyOneMailbox(trigger.claimedFromFilter);
      } catch {
        throw new EmailReceiptDispositionError(
          "failed",
          "EMAIL_RECEIPT_CLAIMED_FROM_FILTER_INVALID",
          trigger,
        );
      }
      if (filter !== normalized.claimedFrom) {
        throw new EmailReceiptDispositionError(
          "rejected",
          "EMAIL_RECEIPT_CLAIMED_FROM_MISMATCH",
          trigger,
        );
      }
    }
    return await admitEmailReceipt(claimed.id, normalized, trigger);
  } catch (error) {
    if (error instanceof EmailReceiptDispositionError) {
      return await finishEmailReceipt(
        claimed.id,
        error.state,
        error.reason,
        error.trigger,
      );
    }
    throw error;
  }
}

async function claimReceiptForHydration(
  receiptId: string,
): Promise<ClaimedReceipt | null> {
  return knowledgeDb.transaction(async (transaction) => {
    const [receipt] = await transaction
      .select({
        id: schema.emailDeliveryReceipts.id,
        organizationId: schema.emailDeliveryReceipts.organizationId,
        receivingConnectionId:
          schema.emailDeliveryReceipts.receivingConnectionId,
        resendEmailId: schema.emailDeliveryReceipts.resendEmailId,
        state: schema.emailDeliveryReceipts.state,
      })
      .from(schema.emailDeliveryReceipts)
      .where(eq(schema.emailDeliveryReceipts.id, receiptId))
      .limit(1)
      .for("update");
    if (!receipt || !["queued", "hydrating"].includes(receipt.state)) {
      return null;
    }
    const [authority] = await transaction
      .select({
        encryptedApiKey:
          schema.organizationReceivingConnections.encryptedApiKey,
        credentialStatus:
          schema.organizationReceivingConnections.credentialStatus,
        inboundEnabled: schema.organizationReceivingConnections.inboundEnabled,
        webhookStatus: schema.organizationReceivingConnections.webhookStatus,
        organizationState: schema.organizations.lifecycleState,
      })
      .from(schema.organizationReceivingConnections)
      .innerJoin(
        schema.organizations,
        eq(
          schema.organizations.id,
          schema.organizationReceivingConnections.organizationId,
        ),
      )
      .where(
        and(
          eq(
            schema.organizationReceivingConnections.id,
            receipt.receivingConnectionId,
          ),
          eq(
            schema.organizationReceivingConnections.organizationId,
            receipt.organizationId,
          ),
        ),
      )
      .limit(1);
    if (
      !authority?.encryptedApiKey ||
      authority.credentialStatus !== "full_access" ||
      !authority.inboundEnabled ||
      authority.webhookStatus !== "active" ||
      authority.organizationState !== "active"
    ) {
      await scrubTerminalReceiptInTransaction(transaction, {
        receiptId,
        state: "failed",
        reason: "EMAIL_RECEIPT_CONNECTION_UNAVAILABLE",
      });
      return null;
    }
    if (receipt.state === "queued") {
      await transaction
        .update(schema.emailDeliveryReceipts)
        .set({ state: "hydrating", updatedAt: new Date() })
        .where(
          and(
            eq(schema.emailDeliveryReceipts.id, receiptId),
            eq(schema.emailDeliveryReceipts.state, "queued"),
          ),
        );
    }
    return {
      id: receipt.id,
      organizationId: receipt.organizationId,
      resendEmailId: receipt.resendEmailId,
      encryptedApiKey: authority.encryptedApiKey,
    };
  });
}

export function normalizeReceivedEmail(email: ReceivedEmailHydration) {
  try {
    const claimedFrom = parseExactlyOneMailbox(email.from);
    const to = parseMailboxFields(email.to);
    const cc = parseMailboxFields(email.cc);
    const bcc = parseMailboxFields(email.bcc);
    const replyTo = parseMailboxFields(email.replyTo);
    const subject = boundedText(email.subject, EMAIL_SUBJECT_MAX_LENGTH);
    const body = selectEmailBody(email.text, email.html);
    const attachments = email.attachments.map(normalizeAttachment);
    if (attachments.length > EMAIL_ATTACHMENT_MAX_COUNT) {
      throw new EmailReceiptDispositionError(
        "failed",
        "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED",
      );
    }
    return {
      claimedFrom,
      to,
      cc,
      bcc,
      replyTo,
      subject,
      body,
      attachments,
      recipientSet: new Set([...to, ...cc, ...bcc]),
    };
  } catch (error) {
    if (error instanceof EmailReceiptDispositionError) throw error;
    throw new EmailReceiptDispositionError(
      "rejected",
      "EMAIL_RECEIPT_ADDRESS_INVALID",
    );
  }
}

export function parseExactlyOneMailbox(value: string) {
  const addresses = parseMailboxFields([value]);
  if (addresses.length !== 1) throw new Error("Expected one mailbox.");
  const address = addresses[0];
  if (!address) throw new Error("Expected one mailbox.");
  return address;
}

export function parseMailboxFields(values: readonly string[]) {
  if (values.length > EMAIL_MAILBOX_LIST_MAX_COUNT) {
    throw new Error("Mailbox list is out of bounds.");
  }
  const parsed: string[] = [];
  for (const value of values) {
    boundedText(value, EMAIL_MAILBOX_MAX_LENGTH);
    const entries = emailAddresses.parseAddressList({
      input: value,
      strict: true,
      rfc6532: true,
    });
    if (!entries?.length) throw new Error("Mailbox is malformed.");
    for (const entry of entries) {
      const mailboxes = entry.type === "group" ? entry.addresses : [entry];
      if (mailboxes.length === 0) throw new Error("Mailbox group is empty.");
      for (const mailbox of mailboxes) {
        parsed.push(normalizeMailbox(mailbox.local, mailbox.domain));
      }
    }
  }
  if (parsed.length > EMAIL_MAILBOX_LIST_MAX_COUNT) {
    throw new Error("Mailbox list is out of bounds.");
  }
  return parsed;
}

function normalizeMailbox(local: string, domain: string) {
  const address = `${local}@${domain}`.toLowerCase();
  return boundedText(address, EMAIL_MAILBOX_MAX_LENGTH);
}

export function selectEmailBody(text: string | null, html: string | null) {
  const plain = text?.trim();
  if (
    !plain &&
    html &&
    new TextEncoder().encode(html).byteLength > EMAIL_MODEL_VISIBLE_MAX_BYTES
  ) {
    throw new EmailReceiptDispositionError(
      "failed",
      "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED",
    );
  }
  const body = plain || (html ? deterministicHtmlToText(html) : "");
  if (!body.trim()) {
    throw new EmailReceiptDispositionError(
      "failed",
      "EMAIL_RECEIPT_BODY_UNUSABLE",
    );
  }
  if (
    new TextEncoder().encode(body).byteLength > EMAIL_MODEL_VISIBLE_MAX_BYTES
  ) {
    throw new EmailReceiptDispositionError(
      "failed",
      "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED",
    );
  }
  return body;
}

export function deterministicHtmlToText(html: string) {
  const blockTags = [
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "div",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ];
  const sanitized = sanitizeHtml(html, {
    allowedTags: blockTags,
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });
  return sanitized
    .replace(new RegExp(`</?(?:${blockTags.join("|")})[^>]*>`, "giu"), "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeAttachment(
  attachment: ReceivedEmailAttachment,
  providerOrder: number,
) {
  return {
    ...attachment,
    providerOrder,
    filename:
      attachment.filename === null
        ? null
        : boundedText(
            attachment.filename,
            EMAIL_ATTACHMENT_FILENAME_MAX_LENGTH,
          ),
    declaredMediaType: boundedText(
      attachment.declaredMediaType,
      EMAIL_MEDIA_TYPE_MAX_LENGTH,
    ),
    disposition:
      attachment.disposition === null
        ? null
        : boundedText(attachment.disposition, EMAIL_DISPOSITION_MAX_LENGTH),
    contentId:
      attachment.contentId === null
        ? null
        : boundedText(attachment.contentId, EMAIL_CONTENT_ID_MAX_LENGTH),
  };
}

function boundedText(value: string, maxLength: number) {
  if (value.length > maxLength) {
    throw new EmailReceiptDispositionError(
      "failed",
      "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED",
    );
  }
  return value;
}

async function resolveEmailTrigger(
  organizationId: string,
  recipients: ReadonlySet<string>,
): Promise<ResolvedTrigger> {
  const triggers = await knowledgeDb
    .select({
      id: schema.projectEmailTriggers.id,
      organizationId: schema.projectEmailTriggers.organizationId,
      addressLocalPart: schema.projectEmailTriggers.addressLocalPart,
      addressDomain: schema.projectEmailTriggers.addressDomain,
      claimedFromFilter: schema.projectEmailTriggers.claimedFromFilter,
      enabled: schema.projectEmailTriggers.enabled,
      revision: schema.projectEmailTriggers.revision,
      deletedAt: schema.projectEmailTriggers.deletedAt,
    })
    .from(schema.projectEmailTriggers)
    .where(eq(schema.projectEmailTriggers.organizationId, organizationId));
  const addressed = triggers.filter((trigger) =>
    recipients.has(
      normalizeMailbox(trigger.addressLocalPart, trigger.addressDomain),
    ),
  );
  const enabled = addressed.filter(
    (trigger) => trigger.enabled && trigger.deletedAt === null,
  );
  if (enabled.length > 1) {
    throw new EmailReceiptDispositionError(
      "rejected",
      "EMAIL_RECEIPT_TRIGGER_AMBIGUOUS",
    );
  }
  const match = enabled[0];
  if (!match) {
    throw new EmailReceiptDispositionError(
      "rejected",
      addressed.length > 0
        ? "EMAIL_RECEIPT_TRIGGER_DISABLED"
        : "EMAIL_RECEIPT_TRIGGER_NOT_FOUND",
    );
  }
  return match;
}

async function admitEmailReceipt(
  receiptId: string,
  email: ReturnType<typeof normalizeReceivedEmail>,
  trigger: ResolvedTrigger,
) {
  return knowledgeDb.transaction(async (transaction) => {
    const [receipt] = await transaction
      .select({ state: schema.emailDeliveryReceipts.state })
      .from(schema.emailDeliveryReceipts)
      .where(eq(schema.emailDeliveryReceipts.id, receiptId))
      .limit(1)
      .for("update");
    if (!receipt || receipt.state !== "hydrating") {
      return { outcome: "terminal_or_unavailable" as const };
    }
    const [currentTrigger] = await transaction
      .select({
        id: schema.projectEmailTriggers.id,
        revision: schema.projectEmailTriggers.revision,
        enabled: schema.projectEmailTriggers.enabled,
        addressLocalPart: schema.projectEmailTriggers.addressLocalPart,
        addressDomain: schema.projectEmailTriggers.addressDomain,
        deletedAt: schema.projectEmailTriggers.deletedAt,
      })
      .from(schema.projectEmailTriggers)
      .where(
        and(
          eq(schema.projectEmailTriggers.id, trigger.id),
          eq(
            schema.projectEmailTriggers.organizationId,
            trigger.organizationId,
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !currentTrigger ||
      !currentTrigger.enabled ||
      currentTrigger.deletedAt !== null ||
      currentTrigger.revision !== trigger.revision ||
      !email.recipientSet.has(
        normalizeMailbox(
          currentTrigger.addressLocalPart,
          currentTrigger.addressDomain,
        ),
      )
    ) {
      await scrubTerminalReceiptInTransaction(transaction, {
        receiptId,
        state: "rejected",
        reason: "EMAIL_RECEIPT_TRIGGER_CHANGED",
        trigger,
      });
      return { outcome: "rejected" as const };
    }

    for (const attachment of email.attachments) {
      await transaction
        .insert(schema.emailDeliveryAttachments)
        .values({
          id: randomUUID(),
          organizationId: trigger.organizationId,
          receiptId,
          providerAttachmentId: attachment.providerAttachmentId,
          providerOrder: attachment.providerOrder,
          filename: attachment.filename,
          declaredMediaType: attachment.declaredMediaType,
          providerSizeBytes: attachment.providerSizeBytes,
          disposition: attachment.disposition,
          contentId: attachment.contentId,
          importState: "available",
        })
        .onConflictDoNothing();
    }
    const storedAttachments = await transaction
      .select()
      .from(schema.emailDeliveryAttachments)
      .where(eq(schema.emailDeliveryAttachments.receiptId, receiptId))
      .orderBy(asc(schema.emailDeliveryAttachments.providerOrder));
    if (!deliveryAttachmentsAgree(storedAttachments, email.attachments)) {
      throw new Error("Delivery Attachment recovery evidence is inconsistent.");
    }

    const now = new Date();
    await transaction
      .update(schema.emailDeliveryReceipts)
      .set({
        state: "admitted",
        reason: null,
        triggerOrganizationId: trigger.organizationId,
        triggerId: trigger.id,
        triggerRevision: trigger.revision,
        claimedFrom: email.claimedFrom,
        toMailboxes: email.to,
        ccMailboxes: email.cc,
        bccMailboxes: email.bcc,
        replyToMailboxes: email.replyTo,
        subject: email.subject,
        textBody: email.body,
        htmlBody: null,
        hydratedAt: now,
        admittedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.emailDeliveryReceipts.id, receiptId),
          eq(schema.emailDeliveryReceipts.state, "hydrating"),
        ),
      );
    return { outcome: "admitted" as const };
  });
}

function deliveryAttachmentsAgree(
  stored: Array<typeof schema.emailDeliveryAttachments.$inferSelect>,
  hydrated: Array<ReturnType<typeof normalizeAttachment>>,
) {
  return (
    stored.length === hydrated.length &&
    stored.every((row, index) => {
      const expected = hydrated[index];
      return (
        expected !== undefined &&
        row.providerAttachmentId === expected.providerAttachmentId &&
        row.providerOrder === expected.providerOrder &&
        row.filename === expected.filename &&
        row.declaredMediaType === expected.declaredMediaType &&
        row.providerSizeBytes === expected.providerSizeBytes &&
        row.disposition === expected.disposition &&
        row.contentId === expected.contentId
      );
    })
  );
}

async function finishEmailReceipt(
  receiptId: string,
  state: TerminalState,
  reason: EmailReceiptTerminalReason,
  trigger?: { id: string; organizationId: string; revision: number },
) {
  return knowledgeDb.transaction(async (transaction) => {
    const [receipt] = await transaction
      .select({ state: schema.emailDeliveryReceipts.state })
      .from(schema.emailDeliveryReceipts)
      .where(eq(schema.emailDeliveryReceipts.id, receiptId))
      .limit(1)
      .for("update");
    if (!receipt || !["queued", "hydrating"].includes(receipt.state)) {
      return { outcome: "terminal_or_unavailable" as const };
    }
    await scrubTerminalReceiptInTransaction(transaction, {
      receiptId,
      state,
      reason,
      trigger,
    });
    return { outcome: state };
  });
}

async function scrubTerminalReceiptInTransaction(
  transaction: HydrationTransaction,
  input: {
    receiptId: string;
    state: TerminalState;
    reason: EmailReceiptTerminalReason;
    trigger?: { id: string; organizationId: string; revision: number };
  },
) {
  await transaction
    .delete(schema.emailDeliveryAttachments)
    .where(eq(schema.emailDeliveryAttachments.receiptId, input.receiptId));
  const now = new Date();
  await transaction
    .update(schema.emailDeliveryReceipts)
    .set({
      state: input.state,
      reason: input.reason,
      triggerOrganizationId: input.trigger?.organizationId ?? null,
      triggerId: input.trigger?.id ?? null,
      triggerRevision: input.trigger?.revision ?? null,
      claimedFrom: null,
      toMailboxes: null,
      ccMailboxes: null,
      bccMailboxes: null,
      receivedForMailboxes: null,
      replyToMailboxes: null,
      subject: null,
      textBody: null,
      htmlBody: null,
      hydratedAt: null,
      admittedAt: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.emailDeliveryReceipts.id, input.receiptId),
        inArray(schema.emailDeliveryReceipts.state, ["queued", "hydrating"]),
      ),
    );
}

function providerFailureState(
  _code: EmailReceiptProviderError["code"],
): TerminalState {
  return "failed";
}

function providerFailureReason(
  code: EmailReceiptProviderError["code"],
): EmailReceiptTerminalReason {
  switch (code) {
    case "EMAIL_RECEIPT_PROVIDER_PERMANENT":
    case "EMAIL_RECEIPT_PROVIDER_RESPONSE_INVALID":
    case "EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED":
      return code;
    case "EMAIL_RECEIPT_PROVIDER_TEMPORARY":
      throw new Error("Temporary provider failures remain retryable.");
  }
}

export async function readAdmittedEmailEnvelope(
  receiptId: string,
): Promise<AdmittedEmailEnvelope | null> {
  const receipt = await knowledgeDb.query.emailDeliveryReceipts.findFirst({
    columns: {
      id: true,
      state: true,
      claimedFrom: true,
      toMailboxes: true,
      ccMailboxes: true,
      bccMailboxes: true,
      replyToMailboxes: true,
      subject: true,
      textBody: true,
    },
    where: and(
      eq(schema.emailDeliveryReceipts.id, receiptId),
      inArray(schema.emailDeliveryReceipts.state, ["admitted", "materialized"]),
    ),
  });
  if (
    !receipt?.claimedFrom ||
    !receipt.toMailboxes ||
    !receipt.ccMailboxes ||
    !receipt.bccMailboxes ||
    !receipt.replyToMailboxes ||
    receipt.subject === null ||
    !receipt.textBody
  ) {
    return null;
  }
  const attachments = await knowledgeDb
    .select({
      id: schema.emailDeliveryAttachments.id,
      order: schema.emailDeliveryAttachments.providerOrder,
      filename: schema.emailDeliveryAttachments.filename,
      declaredMediaType: schema.emailDeliveryAttachments.declaredMediaType,
      sizeBytes: schema.emailDeliveryAttachments.providerSizeBytes,
      disposition: schema.emailDeliveryAttachments.disposition,
      contentId: schema.emailDeliveryAttachments.contentId,
    })
    .from(schema.emailDeliveryAttachments)
    .where(eq(schema.emailDeliveryAttachments.receiptId, receiptId))
    .orderBy(asc(schema.emailDeliveryAttachments.providerOrder));
  return {
    receiptId: receipt.id,
    claimedFrom: receipt.claimedFrom,
    to: receipt.toMailboxes,
    cc: receipt.ccMailboxes,
    bcc: receipt.bccMailboxes,
    replyTo: receipt.replyToMailboxes,
    subject: receipt.subject,
    body: receipt.textBody,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      declaredMediaType: attachment.declaredMediaType ?? "",
    })),
  };
}
