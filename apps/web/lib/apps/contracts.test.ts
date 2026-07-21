import assert from "node:assert/strict";
import {
  createEnvironmentAppConnectionSchema,
  environmentAppCapabilityGrantSchema,
} from "./contracts";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Environment connection input accepts named Tavily connections", () => {
  assert.deepEqual(
    createEnvironmentAppConnectionSchema.parse({
      name: "Primary",
      apiKey: "tvly-secret",
      projectId: "research",
    }),
    {
      kind: "api_key",
      name: "Primary",
      apiKey: "tvly-secret",
      projectId: "research",
    }
  );
});

contractTest("web.hermetic", "Environment connection endpoints must be HTTPS and contain no credentials", () => {
  assert.throws(() =>
    createEnvironmentAppConnectionSchema.parse({
      name: "Primary",
      apiKey: "tvly-secret",
      baseUrl: "https://user:secret@example.test",
    })
  );
});

contractTest("web.hermetic", "disabling a capability always makes the ceiling deny", () => {
  assert.deepEqual(
    environmentAppCapabilityGrantSchema.parse({
      enabled: false,
      approvalMode: "auto",
      loggingMode: "metadata_only",
      rateLimitMode: "default",
    }),
    {
      enabled: false,
      approvalMode: "deny",
      loggingMode: "metadata_only",
      rateLimitMode: "default",
    }
  );
});
