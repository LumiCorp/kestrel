import assert from "node:assert/strict";
import test from "node:test";
import { parsePreparedGmailMutationApproval } from "./gmail-mutation-preparation";

test("Gmail execution reconstructs the exact approved send payload", () => {
  const approvalPayload = {
    operation: "gmail.messages.send",
    envelope: {
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      subject: "Approved subject",
      text: "Approved body",
      html: "<p>Approved body</p>",
    },
    attachments: [{
      fileId: "file-1",
      filename: "approved.txt",
      mediaType: "text/plain",
      sizeBytes: 8,
      sha256: "a".repeat(64),
    }],
  };

  const prepared = parsePreparedGmailMutationApproval(approvalPayload);

  assert.deepEqual(prepared.approvalPayload, approvalPayload);
  assert.deepEqual(prepared.envelope, approvalPayload.envelope);
  assert.deepEqual(prepared.attachments, approvalPayload.attachments);
});

test("Gmail execution reconstructs the approved reply target without re-reading Gmail", () => {
  const prepared = parsePreparedGmailMutationApproval({
    operation: "gmail.messages.reply",
    replyTarget: {
      messageId: "provider-message",
      threadId: "provider-thread",
      recipients: ["reply@example.com"],
      subject: "Re: Approved subject",
      inReplyTo: "<provider-message@example.com>",
      references: "<older@example.com> <provider-message@example.com>",
    },
    body: { text: "Approved reply" },
    attachments: [],
  });

  assert.deepEqual(prepared.envelope, {
    to: ["reply@example.com"],
    cc: [],
    subject: "Re: Approved subject",
    text: "Approved reply",
    threadId: "provider-thread",
    replyHeaders: {
      inReplyTo: "<provider-message@example.com>",
      references: "<older@example.com> <provider-message@example.com>",
    },
  });
});

test("Gmail execution rejects malformed or mismatched persisted approval payloads", () => {
  assert.throws(
    () => parsePreparedGmailMutationApproval({ operation: "gmail.messages.reply", body: { text: "body" }, attachments: [] }),
    /reply approval target is invalid/u,
  );
  assert.throws(
    () => parsePreparedGmailMutationApproval({ operation: "gmail.messages.delete", attachments: [] }),
    /operation is invalid/u,
  );
});
