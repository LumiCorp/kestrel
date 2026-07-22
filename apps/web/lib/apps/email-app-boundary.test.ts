import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest("web.hermetic", "Email App requires project access, ask approval, and organization sender configuration", async () => {
  const source = await readFile(new URL("../../app/api/runtime/email/action/route.ts", import.meta.url), "utf8");
  assert.match(source, /resolveEffectiveProjectAppAccess/u);
  assert.match(source, /capability\?\.approvalMode === "ask"/u);
  assert.match(source, /consumeAppOperationApproval/u);
  assert.match(source, /resolveOrganizationEmailConfig\(ticket\.organizationId\)/u);
  assert.doesNotMatch(source, /resolvePlatformEmailConfig|RESEND_API_KEY/u);
});

contractTest("web.hermetic", "Email App persists metadata without message content or raw addresses", async () => {
  const [route, schema] = await Promise.all([
    readFile(new URL("../../app/api/runtime/email/action/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../drizzle/schema.ts", import.meta.url), "utf8"),
  ]);
  const deliveryStart = schema.indexOf("export const organizationEmailDeliveries");
  const deliveryEnd = schema.indexOf("export const", deliveryStart + 20);
  const deliverySchema = schema.slice(deliveryStart, deliveryEnd);
  assert.match(route, /recipientCount/u);
  assert.match(route, /recipientDomains/u);
  assert.match(route, /subjectHash/u);
  assert.doesNotMatch(deliverySchema, /recipient_address|subject_text|body|html|text_content/u);
});

contractTest("web.hermetic", "Email App has no attachment input and expired payloads are redacted", async () => {
  const [tool, approvals] = await Promise.all([
    readFile(new URL("../../../../tools/kestrelOne/email.ts", import.meta.url), "utf8"),
    readFile(new URL("./app-operation-approvals.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(tool, /attachments?\s*:/u);
  assert.match(approvals, /expireStaleAppOperationApprovals/u);
  assert.match(approvals, /'email'[\s\S]*redacted/u);
});
