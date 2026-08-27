import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatEmailDeliveryEnvelope } from "./materialize";

test("the versioned email envelope keeps every provider attachment identity out of model input", () => {
  const envelope = formatEmailDeliveryEnvelope({
    trigger: { name: "Invoice intake", instruction: "Process the invoice." },
    receipt: {
      receiptId: "receipt-1",
      receivedAt: "2026-08-27T14:00:00.000Z",
      claimedFrom: "customer@example.test",
      to: ["intake@example.test"],
      cc: [],
      replyTo: [],
      subject: "Invoice 123",
      body: "Please process this invoice.",
      attachments: [
        {
          id: "delivery-attachment-opaque-id",
          order: 0,
          filename: "invoice.pdf",
          declaredMediaType: "application/pdf",
          sizeBytes: 42,
          disposition: "attachment",
          contentId: null,
        },
      ],
    },
  });

  assert.match(envelope, /^Kestrel received email envelope v1/mu);
  assert.match(envelope, /untrusted external input/u);
  assert.match(envelope, /delivery-attachment-opaque-id/u);
  assert.doesNotMatch(envelope, /provider_attachment_id|download_url|resend/iu);
});

test("the ordinary receipt worker materializes admitted work through the existing durable turn queue", async () => {
  const queue = await readFile(
    new URL("../turns/queue.ts", import.meta.url),
    "utf8",
  );

  assert.match(queue, /materializeAdmittedEmailDeliveryReceipt/u);
  assert.match(queue, /processEmailDeliveryReceipt\(\s*receiptId\s*\)/u);
  assert.match(
    queue,
    /materialized\?\.turnId && materialized\.shouldDispatch/u,
  );
  assert.match(queue, /\["queued",\s*"hydrating",\s*"admitted"\]/u);
});

test("normal Thread and Trigger surfaces expose receipt provenance without widening origins", async () => {
  const [threadStore, snapshot, route, triggerStore, triggerClient] =
    await Promise.all([
      readFile(new URL("../threads/store.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../turns/conversation-snapshot.server.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../app/api/threads/[id]/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../email-triggers/store.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../components/email-triggers/email-triggers-client.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

  assert.match(threadStore, /EmailDeliveryReceiptProvenance/u);
  assert.match(snapshot, /emailReceipt/u);
  assert.match(route, /emailReceipt: thread\.emailReceipt/u);
  assert.match(triggerStore, /latestReceipt/u);
  assert.match(triggerClient, /Latest delivery:/u);
  assert.doesNotMatch(threadStore, /origin:\s*"email"/u);
});

test("Trigger inspection includes every receipt lifecycle state without copying email content", async () => {
  const triggerStore = await readFile(
    new URL("../email-triggers/store.ts", import.meta.url),
    "utf8",
  );
  const triggerClient = await readFile(
    new URL(
      "../../components/email-triggers/email-triggers-client.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(triggerStore, /case "queued":/u);
  assert.match(triggerStore, /case "hydrating":/u);
  assert.match(triggerStore, /case "materialized":/u);
  assert.match(triggerStore, /reason: schema\.emailDeliveryReceipts\.reason/u);
  assert.match(triggerClient, /Receipt \$\{trigger\.latestReceipt\.id\}/u);
  assert.doesNotMatch(triggerStore, /claimedFrom:\s*schema\.emailDeliveryReceipts/u);
  assert.doesNotMatch(triggerStore, /subject:\s*schema\.emailDeliveryReceipts/u);
  assert.match(triggerClient, /Latest delivery: \{trigger\.latestReceipt\.state\}/u);
});

test("attachment import is receipt-scoped and returns through the canonical Thread file surface", async () => {
  const [importer, route, profile] = await Promise.all([
    readFile(new URL("./attachment-import.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../app/api/kestrel/tools/email/get-attachment/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../agent/kestrel-tool-profile.ts", import.meta.url), "utf8"),
  ]);

  assert.match(importer, /materializedThreadId, input\.ticket\.threadId/u);
  assert.match(importer, /attachment\.projectId !== execution\.projectId/u);
  assert.match(importer, /initializeThreadFile/u);
  assert.match(importer, /uploadThreadFile/u);
  assert.match(importer, /pg_advisory_xact_lock/u);
  assert.doesNotMatch(importer, /console\.(?:log|info|warn|error)/u);
  assert.match(route, /openVisibleFileForThread/u);
  assert.match(route, /parseEmailAttachmentCapabilityRequest/u);
  assert.match(profile, /emailAttachmentReadAvailable/u);
});
