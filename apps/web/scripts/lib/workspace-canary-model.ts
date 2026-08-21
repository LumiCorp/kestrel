export const WORKSPACE_CANARY_HOSTED_GATEWAY_PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
] as const;

type WorkspaceCanaryHostedGatewayProvider =
  (typeof WORKSPACE_CANARY_HOSTED_GATEWAY_PROVIDERS)[number];

export type WorkspaceCanaryApprovedModel = {
  id?: unknown;
  modality?: unknown;
  gatewayId?: unknown;
  gatewayProvider?: unknown;
  metadata?: unknown;
};

export type WorkspaceCanaryModel = {
  id: string;
  gatewayProvider: WorkspaceCanaryHostedGatewayProvider;
};

export function selectWorkspaceCanaryModel(
  models: readonly WorkspaceCanaryApprovedModel[],
  requestedModelId: string,
): WorkspaceCanaryModel {
  const matches = models.filter((model) => model.id === requestedModelId);
  if (matches.length !== 1) {
    throw new Error(
      `KESTREL_ONE_CANARY_MODEL_ID must identify exactly one approved language model; found ${matches.length} matches for ${JSON.stringify(requestedModelId)}.`,
    );
  }

  const model = matches[0]!;
  if (
    model.modality !== "language" ||
    typeof model.gatewayId !== "string" ||
    model.gatewayId.length === 0 ||
    !isWorkspaceCanaryHostedGatewayProvider(model.gatewayProvider) ||
    isDesktopLocalModel(model.metadata)
  ) {
    throw new Error(
      `KESTREL_ONE_CANARY_MODEL_ID must use an approved OpenAI, Anthropic, or OpenRouter API model; ${JSON.stringify(requestedModelId)} uses ${JSON.stringify(model.gatewayProvider)}.`,
    );
  }

  return {
    id: requestedModelId,
    gatewayProvider: model.gatewayProvider,
  };
}

export function createWorkspaceCanaryTurnBody(input: {
  messageId: string;
  modelId: string;
  command: string;
}) {
  return {
    message: {
      id: input.messageId,
      parts: [
        {
          type: "text",
          text: `Run exactly one exec_command with this exact command: ${input.command}`,
        },
      ],
    },
    interactionMode: "build",
    model: input.modelId,
  } as const;
}

export function readWorkspaceCanaryTurnStatus(
  status: string | undefined,
): "completed" | "pending" {
  if (status === "completed") return "completed";
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "contract_failure"
  ) {
    throw new Error(`The build-mode command canary ended with status ${status}.`);
  }
  return "pending";
}

function isWorkspaceCanaryHostedGatewayProvider(
  value: unknown,
): value is WorkspaceCanaryHostedGatewayProvider {
  return WORKSPACE_CANARY_HOSTED_GATEWAY_PROVIDERS.some(
    (provider) => provider === value,
  );
}

function isDesktopLocalModel(metadata: unknown) {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).desktopLocal === true
  );
}
