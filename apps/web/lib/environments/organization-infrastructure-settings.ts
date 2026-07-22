import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { ENVIRONMENT_RUNTIME_TEMPLATE } from "./contracts";
import { DEFAULT_FLY_REGION, FLY_REGIONS, isFlyRegionCode } from "./regions";

const settingsSchema = z
  .object({
    allowedRegions: z.array(z.string().refine(isFlyRegionCode)).min(1),
    defaultRegion: z.string().refine(isFlyRegionCode),
    allowedRuntimeTemplates: z.array(z.string().trim().min(1).max(120)).min(1),
    defaultRuntimeTemplate: z.string().trim().min(1).max(120),
  })
  .superRefine((value, context) => {
    if (!value.allowedRegions.includes(value.defaultRegion)) {
      context.addIssue({ code: "custom", path: ["defaultRegion"], message: "Default region must be allowed." });
    }
    if (!value.allowedRuntimeTemplates.includes(value.defaultRuntimeTemplate)) {
      context.addIssue({ code: "custom", path: ["defaultRuntimeTemplate"], message: "Default runtime template must be allowed." });
    }
  });

export type OrganizationInfrastructureSettingsInput = z.infer<typeof settingsSchema>;

export function defaultOrganizationInfrastructureSettings(): OrganizationInfrastructureSettingsInput {
  return {
    allowedRegions: FLY_REGIONS.map((region) => region.code),
    defaultRegion: DEFAULT_FLY_REGION,
    allowedRuntimeTemplates: [ENVIRONMENT_RUNTIME_TEMPLATE],
    defaultRuntimeTemplate: ENVIRONMENT_RUNTIME_TEMPLATE,
  };
}

export async function getOrganizationInfrastructureSettings(organizationId: string) {
  const stored = await knowledgeDb.query.organizationInfrastructureSettings.findFirst({
    where: eq(schema.organizationInfrastructureSettings.organizationId, organizationId),
  });
  return stored
    ? settingsSchema.parse({
        allowedRegions: stored.allowedRegions,
        defaultRegion: stored.defaultRegion,
        allowedRuntimeTemplates: stored.allowedRuntimeTemplates,
        defaultRuntimeTemplate: stored.defaultRuntimeTemplate,
      })
    : defaultOrganizationInfrastructureSettings();
}

export async function saveOrganizationInfrastructureSettings(input: {
  organizationId: string;
  actorUserId: string;
  settings: OrganizationInfrastructureSettingsInput;
}) {
  const settings = settingsSchema.parse(input.settings);
  await knowledgeDb
    .insert(schema.organizationInfrastructureSettings)
    .values({
      organizationId: input.organizationId,
      ...settings,
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.organizationInfrastructureSettings.organizationId,
      set: { ...settings, updatedByUserId: input.actorUserId, updatedAt: new Date() },
    });
  return settings;
}

export function parseOrganizationInfrastructureSettings(value: unknown) {
  return settingsSchema.parse(value);
}
