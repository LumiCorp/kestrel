import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recordEmailIngressTelemetry,
  resendEmailReceivedEventSchema,
} from "./ingress";

const validEvent = {
  type: "email.received",
  created_at: "2026-08-27T12:00:00.000Z",
  data: {
    email_id: "email-1",
    created_at: "2026-08-27T12:00:00.000Z",
    from: "Sender <sender@example.test>",
    to: ["trigger@example.test"],
    bcc: [],
    cc: [],
    message_id: "message-1",
    received_for: ["trigger@example.test"],
    subject: "Invoice",
    attachments: [],
  },
};

test("verified Resend payload validation accepts only the documented email.received shape", () => {
  assert.equal(resendEmailReceivedEventSchema.safeParse(validEvent).success, true);
  const installedSdkShape = resendEmailReceivedEventSchema.safeParse({
    ...validEvent,
    data: {
      ...validEvent.data,
      received_for: undefined,
    },
  });
  assert.equal(installedSdkShape.success, true);
  assert.deepEqual(
    installedSdkShape.success
      ? installedSdkShape.data.data.received_for
      : undefined,
    [],
  );
  assert.equal(
    resendEmailReceivedEventSchema.safeParse({
      ...validEvent,
      type: "email.delivered",
    }).success,
    false,
  );
  assert.equal(
    resendEmailReceivedEventSchema.safeParse({
      ...validEvent,
      tenant: "unverified-selection",
    }).success,
    false,
  );
  assert.equal(
    resendEmailReceivedEventSchema.safeParse({
      ...validEvent,
      data: { ...validEvent.data, to: [""] },
    }).success,
    false,
  );
});

test("ingress telemetry is bounded, allowlisted, and cannot replace an outcome", () => {
  let fields: Record<string, unknown> | undefined;
  recordEmailIngressTelemetry(
    {
      outcome: "accepted",
      durationMs: Number.POSITIVE_INFINITY,
      receiptId: "receipt-correlation",
      created: true,
    },
    (_message, recorded) => {
      fields = recorded;
    },
  );
  assert.deepEqual(fields, {
    outcome: "accepted",
    durationMs: 60_000,
    receiptId: "receipt-correlation",
    created: true,
  });
  assert.doesNotThrow(() =>
    recordEmailIngressTelemetry(
      { outcome: "invalid_signature", durationMs: 1 },
      () => {
        throw new Error("telemetry sink unavailable");
      },
    ),
  );
});

test("the receipt queue is reconciled but deliberately has no hydration consumer in Issue 03", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const queue = fs.readFileSync(
    path.resolve(directory, "../turns/queue.ts"),
    "utf8",
  );
  assert.match(queue, /email\.delivery-receipt\.hydrate/u);
  assert.match(queue, /singletonKey:\s*receiptId/u);
  assert.match(queue, /recoverQueuedEmailDeliveryReceipts/u);
  const store = fs.readFileSync(path.resolve(directory, "store.ts"), "utf8");
  assert.match(
    store,
    /orderBy\(asc\(schema\.emailDeliveryReceipts\.createdAt\)\)[\s\S]*?\.limit\(100\)/u,
  );
  assert.doesNotMatch(
    queue,
    /boss\.work\(\s*EMAIL_DELIVERY_RECEIPT_QUEUE/u,
  );
});
