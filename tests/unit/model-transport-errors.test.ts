import test from "node:test";
import assert from "node:assert/strict";

import { mapAnthropicTransportError } from "../../models/anthropic/AnthropicErrors.js";
import { mapOpenAiTransportError } from "../../models/openai/OpenAiErrors.js";
import { classifyModelTransportFailure } from "../../src/io/ModelTransportError.js";

test("provider boundaries preserve retryable native network classifications", () => {
  const dnsFailure = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }),
  });
  const resetFailure = Object.assign(new Error("connection reset"), {
    code: "ECONNRESET",
  });

  assert.equal(mapOpenAiTransportError(dnsFailure).code, "MODEL_NETWORK_DNS");
  assert.equal(
    (mapAnthropicTransportError(resetFailure) as { code?: unknown }).code,
    "MODEL_NETWORK_ERROR",
  );
});

test("provider boundaries do not classify cancellation as retryable", () => {
  const cancellation = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });

  assert.equal(mapOpenAiTransportError(cancellation).code, "MODEL_PROVIDER_ERROR");
  assert.equal(mapAnthropicTransportError(cancellation), cancellation);
});

test("transport classification requires typed native evidence instead of message text", () => {
  assert.equal(classifyModelTransportFailure(new Error("fetch failed")), undefined);
  assert.equal(
    classifyModelTransportFailure(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      }),
    ),
    "MODEL_NETWORK_ERROR",
  );
});
