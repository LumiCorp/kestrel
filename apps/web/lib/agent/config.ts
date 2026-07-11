import { eq } from "drizzle-orm";
import { getDefaultAIModel } from "@/lib/ai/config";
import { resolvePreferredLanguageModelId } from "@/lib/ai/gateways";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { KV_KEYS, kvGet, kvSet } from "@/lib/knowledge/kv";
import type { AgentConfigData } from "./types";

const DEFAULT_CONFIG: AgentConfigData = {
  id: "default",
  name: "default",
  additionalPrompt: null,
  responseStyle: "concise",
  language: "en",
  defaultModel: getDefaultAIModel(),
  maxStepsMultiplier: 1,
  temperature: 0.7,
  searchInstructions: null,
  citationFormat: "inline",
  isActive: true,
};

export function getDefaultAgentConfig() {
  return { ...DEFAULT_CONFIG };
}

export async function invalidateAgentConfigCache(organizationId: string) {
  await kvSet(KV_KEYS.AGENT_CONFIG_CACHE, null, organizationId);
}

export async function getAgentConfigForOrganization(
  organizationId: string
): Promise<AgentConfigData> {
  const cached = await kvGet<AgentConfigData | null>(
    KV_KEYS.AGENT_CONFIG_CACHE,
    organizationId
  );

  if (cached) {
    return cached;
  }

  const config = await knowledgeDb.query.agentConfig.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.organizationId, organizationId), eq(table.isActive, true)),
  });

  const result: AgentConfigData = config
    ? {
        id: config.id,
        name: config.name,
        additionalPrompt: config.additionalPrompt,
        responseStyle: config.responseStyle ?? "concise",
        language: config.language ?? "en",
        defaultModel:
          (await resolvePreferredLanguageModelId(config.defaultModel)) ??
          getDefaultAIModel(),
        maxStepsMultiplier: config.maxStepsMultiplier ?? 1,
        temperature: config.temperature ?? 0.7,
        searchInstructions: config.searchInstructions,
        citationFormat: config.citationFormat ?? "inline",
        isActive: config.isActive,
      }
    : getDefaultAgentConfig();

  await kvSet(KV_KEYS.AGENT_CONFIG_CACHE, result, organizationId);
  return result;
}

export async function upsertAgentConfigForOrganization(
  organizationId: string,
  updates: Partial<Omit<AgentConfigData, "id" | "name" | "isActive">>
) {
  const existing = await knowledgeDb.query.agentConfig.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.organizationId, organizationId), eq(table.isActive, true)),
  });

  if (existing) {
    const [updated] = await knowledgeDb
      .update(schema.agentConfig)
      .set({
        ...updates,
        ...(updates.defaultModel !== undefined
          ? { defaultModel: updates.defaultModel }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.agentConfig.id, existing.id))
      .returning();

    await invalidateAgentConfigCache(organizationId);
    return updated;
  }

  const defaults = getDefaultAgentConfig();

  const [created] = await knowledgeDb
    .insert(schema.agentConfig)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: "default",
      additionalPrompt: updates.additionalPrompt ?? defaults.additionalPrompt,
      responseStyle: updates.responseStyle ?? defaults.responseStyle,
      language: updates.language ?? defaults.language,
      defaultModel: updates.defaultModel ?? defaults.defaultModel,
      maxStepsMultiplier:
        updates.maxStepsMultiplier ?? defaults.maxStepsMultiplier,
      temperature: updates.temperature ?? defaults.temperature,
      searchInstructions:
        updates.searchInstructions ?? defaults.searchInstructions,
      citationFormat: updates.citationFormat ?? defaults.citationFormat,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await invalidateAgentConfigCache(organizationId);
  return created;
}

export async function resetAgentConfigForOrganization(organizationId: string) {
  const defaults = getDefaultAgentConfig();

  return upsertAgentConfigForOrganization(organizationId, {
    additionalPrompt: null,
    responseStyle: defaults.responseStyle,
    language: defaults.language,
    defaultModel: defaults.defaultModel,
    maxStepsMultiplier: defaults.maxStepsMultiplier,
    temperature: defaults.temperature,
    searchInstructions: null,
    citationFormat: defaults.citationFormat,
  });
}
