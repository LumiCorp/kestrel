import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBoundedResendWebhookBody,
  recordEmailIngressTelemetry,
  RESEND_WEBHOOK_MAX_BODY_BYTES,
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

test("Resend ingress enforces the exact 2 MiB contract before and during its single body read", async () => {
  assert.equal(RESEND_WEBHOOK_MAX_BODY_BYTES, 2 * 1024 * 1024);

  const declaredOversized = trackedStreamRequest([], {
    "content-length": String(RESEND_WEBHOOK_MAX_BODY_BYTES + 1),
  });
  await assert.rejects(
    readBoundedResendWebhookBody(declaredOversized.request),
    /exceeds the allowed size/u,
  );
  assert.equal(declaredOversized.readerCount(), 0);

  const exactPayload = "x".repeat(RESEND_WEBHOOK_MAX_BODY_BYTES);
  const exact = trackedStreamRequest([
    new TextEncoder().encode(exactPayload.slice(0, 1024)),
    new TextEncoder().encode(exactPayload.slice(1024)),
  ]);
  assert.equal(await readBoundedResendWebhookBody(exact.request), exactPayload);
  assert.equal(exact.readerCount(), 1);
  assert.equal(exact.cancelCount(), 0);

  for (const contentLength of [undefined, "malformed", "1"]) {
    const oversized = trackedStreamRequest(
      [
        new Uint8Array(RESEND_WEBHOOK_MAX_BODY_BYTES),
        new Uint8Array([1]),
      ],
      contentLength === undefined
        ? {}
        : { "content-length": contentLength },
    );
    await assert.rejects(
      readBoundedResendWebhookBody(oversized.request),
      /exceeds the allowed size/u,
    );
    assert.equal(oversized.readerCount(), 1);
    assert.equal(oversized.cancelCount(), 1);
  }
});

test("Resend ingress rejects invalid UTF-8 without a second body interpretation", async () => {
  const invalidUtf8 = trackedStreamRequest([
    new Uint8Array([0xc3, 0x28]),
  ]);
  await assert.rejects(readBoundedResendWebhookBody(invalidUtf8.request));
  assert.equal(invalidUtf8.readerCount(), 1);
  assert.equal(invalidUtf8.cancelCount(), 0);
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

function trackedStreamRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
) {
  const request = new Request("http://localhost/webhook", {
    method: "POST",
    headers,
  });
  let readers = 0;
  let cancels = 0;
  Object.defineProperty(request, "body", {
    value: {
      getReader() {
        readers += 1;
        let index = 0;
        return {
          async cancel() {
            cancels += 1;
          },
          async read() {
            const value = chunks[index];
            index += 1;
            return value ? { done: false as const, value } : { done: true as const };
          },
        };
      },
    },
  });
  return {
    request,
    readerCount: () => readers,
    cancelCount: () => cancels,
  };
}
