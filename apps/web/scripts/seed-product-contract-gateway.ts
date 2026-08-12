import {
  createGateway,
  saveGatewayModel,
  syncGatewayModels,
} from "@/lib/ai/gateways";
import { resetDbRuntimeForTests } from "@/lib/db/runtime";

const baseUrl = process.env.AI_AGENT_BASE_URL?.trim();
if (!baseUrl) throw new Error("AI_AGENT_BASE_URL is required.");
const rawModelId = process.env.AI_AGENT_MODEL?.trim();
if (!rawModelId) throw new Error("AI_AGENT_MODEL is required.");
const organizationId = process.env.KESTREL_SEED_ORGANIZATION_ID?.trim();
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!organizationId)
  throw new Error("KESTREL_SEED_ORGANIZATION_ID is required.");
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");
const providerBaseUrl = `${baseUrl.replace(/\/+$/u, "")}/api`;

const gateway = await createGateway({
  organizationId,
  provider: "openrouter",
  displayName: "Product contract fake OpenRouter",
  baseUrl: providerBaseUrl,
  apiKey,
  enabled: true,
  supportedModalities: ["language"],
});
await syncGatewayModels(organizationId, gateway.id);
await saveGatewayModel({
  organizationId,
  gatewayId: gateway.id,
  gatewayProvider: "openrouter",
  gatewayBaseUrl: providerBaseUrl,
  rawModelId,
  modality: "language",
  approved: true,
  isDefault: true,
  description: "Deterministic product-contract model",
});
await resetDbRuntimeForTests();
