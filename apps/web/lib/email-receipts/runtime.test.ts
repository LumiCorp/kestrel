import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_ATTACHMENT_FILENAME_MAX_LENGTH,
  EMAIL_MODEL_VISIBLE_MAX_BYTES,
} from "./bounds";
import {
  deterministicHtmlToText,
  normalizeReceivedEmail,
  parseExactlyOneMailbox,
  parseMailboxFields,
  selectEmailBody,
} from "./runtime";

test("mailbox parsing compares complete normalized addresses", () => {
  assert.equal(
    parseExactlyOneMailbox("Customer <Customer@Example.COM>"),
    "customer@example.com",
  );
  assert.deepEqual(
    parseMailboxFields([
      "First <first@example.com>, Second <second@example.com>",
    ]),
    ["first@example.com", "second@example.com"],
  );
  assert.throws(() => parseExactlyOneMailbox("not-an-address"));
  assert.throws(() =>
    parseExactlyOneMailbox("first@example.com, second@example.com"),
  );
});

test("plain text wins and HTML-only content has one deterministic text fallback", () => {
  assert.equal(
    selectEmailBody(" Plain text body ", "<p>ignored html</p>"),
    "Plain text body",
  );
  assert.equal(
    selectEmailBody(
      null,
      "<p>Invoice &amp; receipt</p><p>Second paragraph</p>",
    ),
    "Invoice &amp; receipt\nSecond paragraph",
  );
  assert.equal(
    deterministicHtmlToText("<script>secret()</script><b>Visible</b>"),
    "Visible",
  );
  assert.throws(
    () => selectEmailBody("  ", "<script>no body</script>"),
    hasReason("EMAIL_RECEIPT_BODY_UNUSABLE"),
  );
});

test("model-visible body and attachment metadata use established ingress bounds", () => {
  assert.throws(
    () => selectEmailBody("x".repeat(EMAIL_MODEL_VISIBLE_MAX_BYTES + 1), null),
    hasReason("EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED"),
  );
  assert.throws(
    () =>
      selectEmailBody(
        null,
        `<p>${"x".repeat(EMAIL_MODEL_VISIBLE_MAX_BYTES + 1)}</p>`,
      ),
    hasReason("EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED"),
  );
  assert.throws(
    () =>
      normalizeReceivedEmail({
        id: "email-1",
        from: "customer@example.com",
        to: ["trigger@example.test"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Invoice",
        text: "Process it",
        html: null,
        attachments: [
          {
            providerAttachmentId: "provider-attachment-1",
            filename: "x".repeat(EMAIL_ATTACHMENT_FILENAME_MAX_LENGTH + 1),
            declaredMediaType: "application/pdf",
            providerSizeBytes: 42,
            disposition: "attachment",
            contentId: null,
          },
        ],
      }),
    hasReason("EMAIL_RECEIPT_CONTENT_BOUNDS_EXCEEDED"),
  );
});

function hasReason(reason: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "reason" in error &&
    Reflect.get(error, "reason") === reason;
}
