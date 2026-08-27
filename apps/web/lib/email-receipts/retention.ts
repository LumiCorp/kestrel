import "server-only";

import { and, inArray, isNull, lt } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const EMAIL_DELIVERY_RECEIPT_RETENTION_DAYS = 30;

/**
 * Removes only scrubbed terminal receipts after their bounded replay window.
 * Materialized receipt and attachment provenance is deliberately retained by
 * the Thread foreign-key lifecycle instead of this daily maintenance path.
 */
export async function purgeExpiredTerminalEmailDeliveryReceipts(input: {
  now?: Date | undefined;
} = {}): Promise<number> {
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - EMAIL_DELIVERY_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const deleted = await knowledgeDb
    .delete(schema.emailDeliveryReceipts)
    .where(
      and(
        inArray(schema.emailDeliveryReceipts.state, ["rejected", "failed"]),
        isNull(schema.emailDeliveryReceipts.materializedThreadId),
        lt(schema.emailDeliveryReceipts.finishedAt, cutoff),
      ),
    )
    .returning({ id: schema.emailDeliveryReceipts.id });
  return deleted.length;
}
