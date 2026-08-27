import test from "node:test";
import assert from "node:assert/strict";
import { kestrelOneEmailGetAttachmentTool } from "./emailGetAttachment.js";

test("email attachment tool uses the execution-scoped App transport with only an opaque ID", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const handler = kestrelOneEmailGetAttachmentTool.createHandler({
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ fileId: "file_123", filename: "invoice.pdf" });
    },
    kestrelOne: {
      appUrl: "https://one.example.test",
      executionTicket: "execution-ticket",
      tenantId: "org_123",
    },
  });

  const result = await handler({ attachmentId: "delivery_attachment_123" }) as {
    output: { fileId: string };
  };
  assert.equal(result.output.fileId, "file_123");
  assert.equal(
    capturedUrl,
    "https://one.example.test/api/kestrel/tools/email/get-attachment",
  );
  assert.deepEqual(capturedInit?.headers, {
    authorization: "Bearer execution-ticket",
    "content-type": "application/json",
    "x-kestrel-tenant-id": "org_123",
    "x-organization-id": "org_123",
  });
  assert.equal(capturedInit?.body, JSON.stringify({ attachmentId: "delivery_attachment_123" }));
  assert.equal(JSON.stringify(capturedInit).includes("resend"), false);
});
