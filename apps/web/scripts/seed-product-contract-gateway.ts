import { createGateway, saveGatewayModel } from "@/lib/ai/gateways";
import { resetDbRuntimeForTests } from "@/lib/db/runtime";

const baseUrl = process.env.AI_AGENT_BASE_URL?.trim();
if (!baseUrl) throw new Error("AI_AGENT_BASE_URL is required.");

const gateway = await createGateway({
  provider: "openrouter",
  displayName: "Product contract fake OpenRouter",
  baseUrl,
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  enabled: true,
  supportedModalities: ["language"],
});
await saveGatewayModel({
  gatewayId: gateway.id,
  gatewayProvider: "openrouter",
  gatewayBaseUrl: baseUrl,
  rawModelId: "gpt-5-mini",
  modality: "language",
  approved: true,
  isDefault: true,
  description: "Deterministic product-contract model",
});
await resetDbRuntimeForTests();
