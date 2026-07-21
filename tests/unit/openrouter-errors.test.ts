import assert from "node:assert/strict";

import {
  createOpenRouterHttpError,
  isOpenRouterProviderSchemaError,
  mapOpenRouterTransportError,
  OpenRouterModelError,
} from "../../models/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "OpenRouter error mapping covers auth/rate/provider/bad response", () => {
  assert.equal(createOpenRouterHttpError(401, "unauthorized").code, "MODEL_AUTH_ERROR");
  assert.equal(createOpenRouterHttpError(403, "forbidden").code, "MODEL_AUTH_ERROR");
  assert.equal(createOpenRouterHttpError(429, "slow down").code, "MODEL_RATE_LIMITED");
  assert.equal(createOpenRouterHttpError(503, "down").code, "MODEL_PROVIDER_ERROR");
  assert.equal(createOpenRouterHttpError(400, "bad req").code, "MODEL_BAD_RESPONSE");
});

contractTest("runtime.hermetic", "OpenRouter bad-response errors include full diagnostics payload", () => {
  const body = JSON.stringify({
    error: {
      message: "Provider returned error",
      metadata: {
        raw: JSON.stringify({
          error: {
            message:
              "Invalid schema for response_format 'kestrel_response': In context=('properties', 'nextAction')",
          },
        }),
      },
    },
  });
  const err = createOpenRouterHttpError(400, body);
  assert.equal(err.code, "MODEL_PROVIDER_SCHEMA");
  assert.equal(err.details !== undefined, true);
  const details = err.details as Record<string, unknown>;
  assert.equal(typeof details.bodyText, "string");
  assert.equal(typeof details.nestedProviderMessage, "string");
  assert.equal(isOpenRouterProviderSchemaError(err), true);
});

contractTest("runtime.hermetic", "OpenRouter transport mapping preserves model errors", () => {
  const err = new OpenRouterModelError("MODEL_AUTH_ERROR", "nope");
  assert.equal(mapOpenRouterTransportError(err), err);
});

contractTest("runtime.hermetic", "OpenRouter transport mapping returns timeout/provider codes", () => {
  const timeout = mapOpenRouterTransportError(new Error("request timed out"));
  assert.equal(timeout.code, "MODEL_TIMEOUT");

  const generic = mapOpenRouterTransportError(new Error("socket hangup"));
  assert.equal(generic.code, "MODEL_PROVIDER_ERROR");
});

contractTest("runtime.hermetic", "OpenRouter transport mapping classifies DNS failures with details", () => {
  const dnsCause = Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), {
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "openrouter.ai",
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), {
    cause: dnsCause,
  });

  const mapped = mapOpenRouterTransportError(fetchError);
  assert.equal(mapped.code, "MODEL_NETWORK_DNS");
  assert.equal(mapped.message.includes("DNS lookup failed"), true);
  assert.equal(mapped.details !== undefined, true);
  const details = mapped.details as Record<string, unknown>;
  assert.equal(Array.isArray(details.chain), true);
  assert.equal(Array.isArray(details.codes), true);
  assert.equal((details.codes as string[]).includes("ENOTFOUND"), true);
});

contractTest("runtime.hermetic", "OpenRouter transport mapping classifies connectivity failures", () => {
  const connCause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), {
    cause: connCause,
  });

  const mapped = mapOpenRouterTransportError(fetchError);
  assert.equal(mapped.code, "MODEL_NETWORK_ERROR");
  assert.equal(mapped.message.includes("network request failed"), true);
});
