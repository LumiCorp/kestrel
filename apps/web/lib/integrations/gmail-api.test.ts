import assert from "node:assert/strict";
import test from "node:test";
import { createGmailRawMessage, getGmailAttachmentBytes, getGmailReplyTarget, GmailProviderError, searchGmailMessages, sendGmailRawMessage } from "./gmail-api";

const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64url");

test("Gmail search preserves the native query and normalizes messages without attachment bytes", async () => {
  const requests: string[] = [];
  const result = await searchGmailMessages({
    accessToken: "secret-token",
    query: "from:billing@example.com newer_than:30d",
    maxResults: 10,
    fetchImpl: async (url) => {
      const value = String(url); requests.push(value);
      if (value.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "provider-secret" }));
      return new Response(JSON.stringify({ id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "Billing <billing@example.com>" }, { name: "To", value: "me@example.com" }, { name: "Subject", value: "Invoice" }], parts: [{ mimeType: "text/plain", body: { data: encoded("Invoice body") } }, { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "a1", size: 42 } }] } }));
    },
  });
  assert.equal(new URL(requests[0]!).searchParams.get("q"), "from:billing@example.com newer_than:30d");
  assert.deepEqual(result.nextPageToken, "provider-secret");
  assert.deepEqual(result.messages[0]?.attachments, [{ attachmentId: "a1", filename: "invoice.pdf", mediaType: "application/pdf", sizeBytes: 42 }]);
  assert.equal(JSON.stringify(result).includes("Invoice body"), true);
  assert.equal(JSON.stringify(result).includes(encoded("Invoice body")), false);
});

test("Gmail MIME construction owns headers and rejects injection", () => {
  const raw = createGmailRawMessage({
    to: ["recipient@example.com"],
    subject: "Status",
    text: "Plain text",
    html: "<p>HTML</p>",
    replyHeaders: { inReplyTo: "<provider-message@example.com>", references: "<older@example.com> <provider-message@example.com>" },
    attachments: [{ filename: "report.txt", mediaType: "text/plain", bytes: Buffer.from("attachment bytes") }],
  });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /^To: recipient@example\.com\r\nSubject: Status\r\n/u);
  assert.match(mime, /MIME-Version: 1\.0/u);
  assert.match(mime, /In-Reply-To: <provider-message@example\.com>/u);
  assert.match(mime, /References: <older@example\.com> <provider-message@example\.com>/u);
  assert.match(mime, /Content-Type: multipart\/mixed/u);
  assert.match(mime, /Content-Type: multipart\/alternative/u);
  assert.match(mime, /Content-Disposition: attachment; filename\*=UTF-8''report\.txt/u);
  assert.match(mime, /YXR0YWNobWVudCBieXRlcw==/u);
  assert.doesNotMatch(mime, /^Bcc:/mu);
  assert.throws(() => createGmailRawMessage({ to: ["recipient@example.com\r\nBcc: injected@example.com"], subject: "Status", text: "body" }), /invalid/u);
});

test("Gmail reply targets come only from the selected provider message", async () => {
  const target = await getGmailReplyTarget({
    accessToken: "secret",
    messageId: "provider-message",
    fetchImpl: async (url) => {
      assert.match(String(url), /\/users\/me\/messages\/provider-message$/u);
      return Response.json({
        id: "provider-message",
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "From", value: "Original sender <from@example.com>" },
            { name: "Reply-To", value: "Reply destination <reply@example.com>" },
            { name: "Subject", value: "Status update" },
            { name: "Message-ID", value: "<provider-message@example.com>" },
            { name: "References", value: "<older@example.com>" },
          ],
        },
      });
    },
  });
  assert.deepEqual(target, {
    threadId: "thread-1",
    recipients: ["reply@example.com"],
    subject: "Re: Status update",
    inReplyTo: "<provider-message@example.com>",
    references: "<older@example.com>",
  });
  await assert.rejects(
    getGmailReplyTarget({
      accessToken: "secret",
      messageId: "bad-message",
      fetchImpl: async () => Response.json({ id: "bad-message", threadId: "thread-1", payload: { headers: [{ name: "From", value: "sender@example.com" }, { name: "Message-ID", value: "<id@example.com>\r\nBcc: injected@example.com" }] } }),
    }),
    (error: unknown) => error instanceof GmailProviderError && error.code === "GMAIL_INVALID_RESPONSE",
  );
});

test("Gmail sends expose a confirmed identity or an unknown outcome without retrying", async () => {
  let callCount = 0;
  const result = await sendGmailRawMessage({ accessToken: "secret", raw: "cmF3LW1pbWU", threadId: "t1", fetchImpl: async (_url, init) => {
    callCount += 1;
    assert.deepEqual(JSON.parse(String(init?.body)), { raw: "cmF3LW1pbWU", threadId: "t1" });
    return Response.json({ id: "m-sent", threadId: "t1", internalDate: "1700000000000" });
  } });
  assert.deepEqual(result, { id: "m-sent", threadId: "t1", createdAt: "1700000000000" });
  assert.equal(callCount, 1);
  await assert.rejects(sendGmailRawMessage({ accessToken: "secret", raw: "cmF3", fetchImpl: async () => { throw new Error("socket closed"); } }), (error: unknown) => error instanceof GmailProviderError && error.code === "GMAIL_OUTCOME_UNKNOWN" && error.outcomeUnknown);
});

test("Gmail attachment bytes are unavailable until explicit import and provider failures stay distinct", async () => {
  const bytes = await getGmailAttachmentBytes({ accessToken: "secret", messageId: "m1", attachmentId: "a1", fetchImpl: async () => new Response(JSON.stringify({ data: encoded("document bytes") })) });
  assert.equal(bytes.toString("utf8"), "document bytes");
  await assert.rejects(
    getGmailAttachmentBytes({ accessToken: "secret", messageId: "m1", attachmentId: "a1", fetchImpl: async () => new Response("denied", { status: 403 }) }),
    (error: unknown) => error instanceof GmailProviderError && error.code === "GMAIL_ACCESS_DENIED" && error.reconnectRequired === false,
  );
});
