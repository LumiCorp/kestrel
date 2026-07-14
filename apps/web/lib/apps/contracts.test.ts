import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentAppConnectionSchema,
  environmentAppCapabilityGrantSchema,
} from "./contracts";

test("Environment connection input accepts named Tavily connections", () => {
  assert.deepEqual(
    createEnvironmentAppConnectionSchema.parse({
      name: "Primary",
      apiKey: "tvly-secret",
      projectId: "research",
    }),
    { name: "Primary", apiKey: "tvly-secret", projectId: "research" }
  );
});

test("Environment connection endpoints must be HTTPS and contain no credentials", () => {
  assert.throws(() =>
    createEnvironmentAppConnectionSchema.parse({
      name: "Primary",
      apiKey: "tvly-secret",
      baseUrl: "https://user:secret@example.test",
    })
  );
});

test("disabling a capability always makes the ceiling deny", () => {
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
