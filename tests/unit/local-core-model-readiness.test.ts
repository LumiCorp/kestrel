import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultLocalCoreRuntimeConfiguration } from "../../src/localCore/runtimeConfiguration.js";
import {
  createLocalCoreModelReadiness,
  isLocalCoreModelRoleReady,
  LocalCoreModelReadinessStore,
  qualifyLocalCoreModelReadiness,
} from "../../src/localCore/modelReadiness.js";

test("Local Core advertises the exact local route without inferring strict agent capability", () => {
  const configuration = createDefaultLocalCoreRuntimeConfiguration();
  const readiness = createLocalCoreModelReadiness({
    runtimeConfiguration: configuration,
    profile: { modelProvider: "ollama", model: "glm-4.5-air" },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });

  assert.equal(readiness.registration.providerId, "ollama");
  assert.equal(readiness.registration.modelId, "glm-4.5-air");
  assert.equal(
    readiness.registration.route.endpointCodec,
    "ollama.openai-compatible.v1",
  );
  assert.equal(readiness.registration.providerConfiguration.protocol, "openai");
  assert.equal(
    readiness.registration.capabilities.providerStrictSchema.state,
    "unsupported",
  );
  assert.equal(readiness.qualification, "pending");
  assert.equal(isLocalCoreModelRoleReady(readiness, "agent.loop"), false);
});

test("Local Core persists a real local schema-validation qualification without upgrading strict roles", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-model-readiness-"));
  context.after(async () => await rm(home, { recursive: true, force: true }));
  const pending = createLocalCoreModelReadiness({
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
    profile: { modelProvider: "ollama", model: "glm-4.5-air" },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  const qualified = await qualifyLocalCoreModelReadiness({
    readiness: pending,
    now: () => new Date("2026-08-27T00:01:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({
      id: "local-qualification",
      model: "glm-4.5-air",
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "{\"ok\":true}" },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(qualified.qualification, "qualified");
  assert.equal(
    qualified.registration.capabilities.localSchemaValidation.state,
    "qualified",
  );
  assert.equal(qualified.registration.capabilities.providerStrictSchema.state, "unsupported");
  assert.equal(isLocalCoreModelRoleReady(qualified, "agent.loop"), false);

  const store = new LocalCoreModelReadinessStore(home);
  await store.append(qualified.registration);
  const restored = await store.readCurrent(pending.registration);
  assert.equal(restored?.registration.fingerprint, qualified.registration.fingerprint);
  assert.equal(restored?.qualification, "qualified");
});

test("Local Core readiness binds the inherited endpoint that the runtime will use", () => {
  const readiness = createLocalCoreModelReadiness({
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration(),
    profile: { modelProvider: "ollama", model: "glm-4.5-air" },
    baseEnv: { OLLAMA_BASE_URL: "http://127.0.0.1:19191" },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });

  assert.equal(
    readiness.registration.route.apiEndpoint,
    "http://127.0.0.1:19191",
  );
});
