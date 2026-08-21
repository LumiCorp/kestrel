import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceCanaryTurnBody,
  readWorkspaceCanaryTurnStatus,
  selectWorkspaceCanaryModel,
} from "./workspace-canary-model";

const hostedProviders = ["openai", "anthropic", "openrouter"] as const;

test("Workspace canary selects each explicit hosted provider API model", () => {
  for (const gatewayProvider of hostedProviders) {
    const id = `${gatewayProvider}/approved-model`;
    assert.deepEqual(
      selectWorkspaceCanaryModel(
        [
          {
            id,
            modality: "language",
            gatewayId: `gateway-${gatewayProvider}`,
            gatewayProvider,
          },
        ],
        id,
      ),
      { id, gatewayProvider },
    );
  }
});

test("Workspace canary rejects missing, unknown, and ambiguous models", () => {
  assert.throws(
    () => selectWorkspaceCanaryModel([], ""),
    /must identify exactly one approved language model/u,
  );
  assert.throws(
    () => selectWorkspaceCanaryModel([], "missing"),
    /found 0 matches/u,
  );
  assert.throws(
    () =>
      selectWorkspaceCanaryModel(
        [
          approvedModel("duplicate", "openai"),
          approvedModel("duplicate", "openrouter"),
        ],
        "duplicate",
      ),
    /found 2 matches/u,
  );
});

test("Workspace canary rejects private and non-provider API models", () => {
  for (const gatewayProvider of ["runpod", "lumi", "ollama"] as const) {
    assert.throws(
      () =>
        selectWorkspaceCanaryModel(
          [approvedModel(`${gatewayProvider}/model`, gatewayProvider)],
          `${gatewayProvider}/model`,
        ),
      /must use an approved OpenAI, Anthropic, or OpenRouter API model/u,
    );
  }

  assert.throws(
    () =>
      selectWorkspaceCanaryModel(
        [
          {
            ...approvedModel("desktop-local:openai:model", "openai"),
            metadata: { desktopLocal: true },
          },
        ],
        "desktop-local:openai:model",
      ),
    /must use an approved OpenAI, Anthropic, or OpenRouter API model/u,
  );
});

test("Workspace canary turn body pins the exact selected model", () => {
  assert.deepEqual(
    createWorkspaceCanaryTurnBody({
      messageId: "message-1",
      modelId: "openrouter/openai/gpt-5.6-luna",
      command: "printf canary",
    }),
    {
      message: {
        id: "message-1",
        parts: [
          {
            type: "text",
            text: "Run exactly one exec_command with this exact command: printf canary",
          },
        ],
      },
      interactionMode: "build",
      model: "openrouter/openai/gpt-5.6-luna",
    },
  );
});

test("Workspace canary preserves failed turns instead of retrying them", () => {
  assert.equal(readWorkspaceCanaryTurnStatus(undefined), "pending");
  assert.equal(readWorkspaceCanaryTurnStatus("completed"), "completed");
  for (const status of [
    "failed",
    "cancelled",
    "contract_failure",
  ] as const) {
    assert.throws(
      () => readWorkspaceCanaryTurnStatus(status),
      new RegExp(`ended with status ${status}`, "u"),
    );
  }
});

function approvedModel(id: string, gatewayProvider: string) {
  return {
    id,
    modality: "language",
    gatewayId: `gateway-${gatewayProvider}`,
    gatewayProvider,
  };
}
