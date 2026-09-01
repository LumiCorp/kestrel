import assert from "node:assert/strict";
import test from "node:test";
import { RESEND_MANAGEMENT_REQUEST_TIMEOUT_MS } from "@/lib/email/receiving-provider";
import {
  EmailReceiptProviderError,
  ResendReceivedEmailProvider,
} from "./provider";

test("retrieval paginates attachments in provider order without retaining signed URLs", async () => {
  const requests: URL[] = [];
  const provider = new ResendReceivedEmailProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (!url.pathname.endsWith("/attachments")) {
        return jsonResponse(receivedEmail());
      }
      const after = url.searchParams.get("after");
      return jsonResponse(
        after
          ? attachmentPage(false, [attachment("provider-2", "second.pdf")])
          : attachmentPage(true, [attachment("provider-1", "first.pdf")]),
      );
    },
    timeoutSignal: () => new AbortController().signal,
  });

  const hydrated = await provider.retrieve("secret", "email-1");

  assert.deepEqual(
    hydrated.attachments.map((value) => value.providerAttachmentId),
    ["provider-1", "provider-2"],
  );
  assert.equal(requests[2]?.searchParams.get("after"), "provider-1");
  assert.doesNotMatch(
    JSON.stringify(hydrated),
    /download_url|expires_at|signed\.resend\.test/u,
  );
});

test("a provider page cannot claim more data without a cursor", async () => {
  const provider = new ResendReceivedEmailProvider({
    fetchImpl: async (input) =>
      requestUrl(input).pathname.endsWith("/attachments")
        ? jsonResponse(attachmentPage(true, []))
        : jsonResponse(receivedEmail()),
    timeoutSignal: () => new AbortController().signal,
  });

  await assert.rejects(
    provider.retrieve("secret", "email-1"),
    (error) =>
      error instanceof EmailReceiptProviderError &&
      error.code === "EMAIL_RECEIPT_PROVIDER_RESPONSE_INVALID" &&
      !error.retryable,
  );
});

test("retrieval applies the established provider deadline and maps transport failure as temporary", async () => {
  const deadlines: number[] = [];
  const provider = new ResendReceivedEmailProvider({
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
    timeoutSignal: (timeoutMs) => {
      deadlines.push(timeoutMs);
      return new AbortController().signal;
    },
  });

  await assert.rejects(
    provider.retrieve("secret", "email-1"),
    (error) =>
      error instanceof EmailReceiptProviderError &&
      error.code === "EMAIL_RECEIPT_PROVIDER_TEMPORARY" &&
      error.retryable,
  );
  assert.deepEqual(deadlines, [RESEND_MANAGEMENT_REQUEST_TIMEOUT_MS]);
});

test("provider status maps temporary and permanent failures distinctly", async () => {
  for (const [status, code, retryable] of [
    [429, "EMAIL_RECEIPT_PROVIDER_TEMPORARY", true],
    [503, "EMAIL_RECEIPT_PROVIDER_TEMPORARY", true],
    [401, "EMAIL_RECEIPT_PROVIDER_PERMANENT", false],
    [404, "EMAIL_RECEIPT_PROVIDER_PERMANENT", false],
  ] as const) {
    const provider = new ResendReceivedEmailProvider({
      fetchImpl: async () => new Response(null, { status }),
      timeoutSignal: () => new AbortController().signal,
    });
    await assert.rejects(
      provider.retrieve("secret", "email-1"),
      (error) =>
        error instanceof EmailReceiptProviderError &&
        error.code === code &&
        error.retryable === retryable,
    );
  }
});

test("attachment download resolves a fresh provider URL and returns only a stream", async () => {
  const requests: URL[] = [];
  const provider = new ResendReceivedEmailProvider({
    baseUrl: "https://resend.test",
    fetchImpl: async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.hostname === "signed.resend.test") {
        return new Response(new TextEncoder().encode("invoice"), {
          headers: { "content-length": "7" },
        });
      }
      return jsonResponse(attachmentPage(false, [attachment("provider-1", "invoice.pdf")]));
    },
    timeoutSignal: () => new AbortController().signal,
  });

  const download = await provider.downloadAttachment({
    apiKey: "secret",
    emailId: "email-1",
    providerAttachmentId: "provider-1",
  });
  assert.equal(download.contentLength, 7);
  assert.equal(await new Response(download.body).text(), "invoice");
  assert.deepEqual(requests.map((url) => url.hostname), [
    "resend.test",
    "signed.resend.test",
  ]);
  assert.equal(JSON.stringify(download).includes("signed.resend.test"), false);
});

function receivedEmail() {
  return {
    object: "email",
    id: "email-1",
    from: "Customer <customer@example.com>",
    to: ["trigger@example.test"],
    cc: null,
    bcc: null,
    reply_to: null,
    subject: "Invoice",
    text: "Please process this invoice.",
    html: null,
  };
}

function attachment(id: string, filename: string) {
  return {
    id,
    filename,
    size: 42,
    content_type: "application/pdf",
    content_disposition: "attachment",
    content_id: `content-${id}`,
    download_url: `https://signed.resend.test/${id}`,
    expires_at: "2026-08-27T12:00:00.000Z",
  };
}

function attachmentPage(hasMore: boolean, data: unknown[]) {
  return { object: "list", has_more: hasMore, data };
}

function jsonResponse(value: unknown) {
  return Response.json(value);
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input);
}
