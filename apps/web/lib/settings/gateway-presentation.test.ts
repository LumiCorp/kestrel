import assert from "node:assert/strict";
import test from "node:test";
import {
  getGatewayCollectionState,
  getGatewayOverview,
} from "./gateway-presentation";

test("Connections never presents loading or failure as an empty collection", () => {
  assert.equal(
    getGatewayCollectionState({ isLoading: true, error: null, count: 0 }),
    "loading",
  );
  assert.equal(
    getGatewayCollectionState({
      isLoading: false,
      error: "Network unavailable",
      count: 0,
    }),
    "error",
  );
  assert.equal(
    getGatewayCollectionState({ isLoading: false, error: null, count: 0 }),
    "empty",
  );
  assert.equal(
    getGatewayCollectionState({ isLoading: false, error: null, count: 1 }),
    "ready",
  );
});

test("Connections derives actionable provider health without flagging local Ollama", () => {
  const model = { approved: true, isDefault: true };

  assert.deepEqual(
    getGatewayOverview({
      gateway: { enabled: true, hasApiKey: false, provider: "ollama" },
      models: [model],
    }),
    {
      approvedCount: 1,
      defaultCount: 1,
      attentionReason: null,
      status: "Ready",
      tone: "positive",
    },
  );
  assert.equal(
    getGatewayOverview({
      gateway: { enabled: true, hasApiKey: false, provider: "openai" },
      models: [model],
    }).attentionReason,
    "API key missing",
  );
  assert.equal(
    getGatewayOverview({
      gateway: { enabled: true, hasApiKey: true, provider: "openai" },
      models: [],
    }).attentionReason,
    "No models synced",
  );
  assert.equal(
    getGatewayOverview({
      gateway: { enabled: false, hasApiKey: false, provider: "openai" },
      models: [],
    }).attentionReason,
    "Provider disabled",
  );
});
