import { and, eq } from "drizzle-orm";

import {
  BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
  resolveBrowserPublicGrantDecision,
  resolveEffectiveBrowserDomainAuthority,
  type BrowserDomainAuthorityInputV1,
  type BrowserEffectiveDomainAuthorityV1,
  type BrowserEnvironmentDomainAuthorityV1,
  type BrowserPersonalDomainAuthorityV1,
  type BrowserProjectDomainAuthorityV1,
  type BrowserPublicDomainAuthorityV1,
  type BrowserPublicGrantDecisionV1,
  type BrowserQaDomainAuthorityV1,
} from "../../../../src/browser/domainAuthority.js";
import type { BrowserMode } from "../../../../src/browser/contracts.js";
import { hashCanonical } from "../../../../src/kestrel/contracts/tool-contract.js";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type {
  BrowserEnvironmentAppSettings,
  BrowserProjectAppSettings,
} from "./types";

export const HOSTED_BROWSER_APP_KEY = "built_in.browser" as const;
/** The request_grant capability owns the settings that define domain authority. */
export const HOSTED_BROWSER_DOMAIN_POLICY_CAPABILITY_KEY =
  "request_grant" as const;

type BrowserDomainTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];
type BrowserDomainReader = Pick<typeof knowledgeDb, "query">;

export const DEFAULT_HOSTED_BROWSER_AGENT_ID = "kestrel-one" as const;

export function hostedBrowserAgentId(): string {
  return process.env.KESTREL_ONE_AGENT_ID?.trim() || DEFAULT_HOSTED_BROWSER_AGENT_ID;
}

export type HostedBrowserEnvironmentSettings = BrowserEnvironmentAppSettings;
export type HostedBrowserProjectSettings = BrowserProjectAppSettings;

export const DEFAULT_HOSTED_BROWSER_ENVIRONMENT_SETTINGS = {
  enabledModes: [],
  personalGrantsEnabled: false,
  configuredPublicDomains: [],
  blockedPublicDomains: [],
} as const satisfies HostedBrowserEnvironmentSettings;

export const DEFAULT_HOSTED_BROWSER_PROJECT_SETTINGS = {
  enabledModes: [],
  personalGrantsEnabled: false,
  blockedPublicDomains: [],
} as const satisfies HostedBrowserProjectSettings;

export function defaultHostedBrowserProjectSettings(
  environment: HostedBrowserEnvironmentSettings,
): HostedBrowserProjectSettings {
  return {
    enabledModes: [...environment.enabledModes],
    personalGrantsEnabled: environment.personalGrantsEnabled,
    blockedPublicDomains: [],
  };
}

export interface HostedBrowserPersonalDomainSummary {
  canonicalDomain: string;
  scheme: "https";
  includeSubdomains: true;
  port: 443;
  status: "active" | "revoked";
  personalRevision: number;
  approvedAt: Date;
  revokedAt: Date | null;
}

export interface HostedBrowserPersonalDomainMutationResult {
  changed: boolean;
  personalRevision: number;
  domain: HostedBrowserPersonalDomainSummary | null;
}

export class HostedBrowserDomainError extends Error {
  constructor(
    readonly code:
      | "BROWSER_DOMAIN_SETTINGS_INVALID"
      | "BROWSER_DOMAIN_SCOPE_NOT_FOUND"
      | "BROWSER_DOMAIN_REVISION_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "HostedBrowserDomainError";
  }
}

export function parseHostedBrowserEnvironmentSettings(
  value: unknown,
): HostedBrowserEnvironmentSettings {
  const settings = exactRecord(
    value,
    [
      "enabledModes",
      "personalGrantsEnabled",
      "configuredPublicDomains",
      "blockedPublicDomains",
    ],
    "Browser Environment settings",
  );
  return {
    enabledModes: parseModes(settings.enabledModes, "enabledModes"),
    personalGrantsEnabled: parseBoolean(
      settings.personalGrantsEnabled,
      "personalGrantsEnabled",
    ),
    configuredPublicDomains: parsePublicDomains(
      settings.configuredPublicDomains,
      "configuredPublicDomains",
    ),
    blockedPublicDomains: parsePublicDomains(
      settings.blockedPublicDomains,
      "blockedPublicDomains",
    ),
  };
}

export function readHostedBrowserEnvironmentSettings(
  value: unknown,
): HostedBrowserEnvironmentSettings {
  return isEmptyRecord(value)
    ? DEFAULT_HOSTED_BROWSER_ENVIRONMENT_SETTINGS
    : parseHostedBrowserEnvironmentSettings(value);
}

export function parseHostedBrowserProjectSettings(
  value: unknown,
): HostedBrowserProjectSettings {
  const settings = exactRecord(
    value,
    ["enabledModes", "personalGrantsEnabled", "blockedPublicDomains"],
    "Browser Project settings",
  );
  return {
    enabledModes: parseModes(settings.enabledModes, "enabledModes"),
    personalGrantsEnabled: parseBoolean(
      settings.personalGrantsEnabled,
      "personalGrantsEnabled",
    ),
    blockedPublicDomains: parsePublicDomains(
      settings.blockedPublicDomains,
      "blockedPublicDomains",
    ),
  };
}

export function readHostedBrowserProjectSettings(
  value: unknown,
  environment: HostedBrowserEnvironmentSettings,
): HostedBrowserProjectSettings {
  return isEmptyRecord(value)
    ? defaultHostedBrowserProjectSettings(environment)
    : parseHostedBrowserProjectSettings(value);
}

export async function readHostedBrowserDomainAuthorityInput(
  input: {
    organizationId: string;
    environmentId: string;
    projectId: string;
    userId: string;
    agentId: string;
    qa: BrowserQaDomainAuthorityV1;
  },
  database: BrowserDomainReader = knowledgeDb,
): Promise<BrowserDomainAuthorityInputV1> {
  requireScopeInput(input);
  requireNonEmpty(input.agentId, "agentId");
  const [
    environment,
    project,
    environmentPolicy,
    projectApp,
    projectPolicy,
    revisionSet,
    domains,
    subjectRestrictions,
  ] = await Promise.all([
    database.query.environments.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.environmentId),
          equals(table.organizationId, input.organizationId),
        ),
      columns: { id: true },
    }),
    database.query.projects.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.projectId),
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
        ),
      columns: { id: true },
    }),
    database.query.environmentAppCapabilityGrants.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.environmentId, input.environmentId),
          equals(table.appKey, HOSTED_BROWSER_APP_KEY),
          equals(
            table.capabilityKey,
            HOSTED_BROWSER_DOMAIN_POLICY_CAPABILITY_KEY,
          ),
        ),
    }),
    database.query.projectApps.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.projectId, input.projectId),
          equals(table.appKey, HOSTED_BROWSER_APP_KEY),
        ),
      columns: { enabled: true, updatedAt: true },
    }),
    database.query.projectAppCapabilityPolicies.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.projectId, input.projectId),
          equals(table.appKey, HOSTED_BROWSER_APP_KEY),
          equals(
            table.capabilityKey,
            HOSTED_BROWSER_DOMAIN_POLICY_CAPABILITY_KEY,
          ),
        ),
    }),
    database.query.browserPersonalDomainRevisionSets.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.userId, input.userId),
        ),
      columns: { revision: true },
    }),
    database.query.browserPersonalDomains.findMany({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.userId, input.userId),
          equals(table.status, "active"),
        ),
      columns: {
        canonicalDomain: true,
        scheme: true,
        includeSubdomains: true,
        port: true,
      },
    }),
    database.query.environmentCapabilitySubjectRestrictions.findMany({
      where: (table, { and: all, eq: equals, isNull, or }) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.environmentId, input.environmentId),
          equals(table.providerKey, HOSTED_BROWSER_APP_KEY),
          equals(
            table.capabilityKey,
            HOSTED_BROWSER_DOMAIN_POLICY_CAPABILITY_KEY,
          ),
          isNull(table.resourceId),
          or(
            all(
              equals(table.subjectType, "actor"),
              equals(table.subjectId, input.userId),
            ),
            all(
              equals(table.subjectType, "agent"),
              equals(table.subjectId, input.agentId),
            ),
          ),
        ),
      columns: {
        subjectType: true,
        subjectId: true,
        enabled: true,
        approvalMode: true,
        updatedAt: true,
      },
    }),
  ]);

  if (!environment || !project) {
    throw new HostedBrowserDomainError(
      "BROWSER_DOMAIN_SCOPE_NOT_FOUND",
      "The Browser domain authority scope was not found.",
    );
  }
  if (!environmentPolicy || !projectPolicy) {
    throw new HostedBrowserDomainError(
      "BROWSER_DOMAIN_SETTINGS_INVALID",
      "Browser Environment and Project policy settings must be configured.",
    );
  }

  const environmentSettings = readHostedBrowserEnvironmentSettings(
    environmentPolicy.settings,
  );
  const projectSettings = readHostedBrowserProjectSettings(
    projectPolicy.settings,
    environmentSettings,
  );
  const environmentEnabled =
    environmentPolicy.enabled &&
    environmentPolicy.approvalMode !== "deny" &&
    subjectRestrictions.every(
      (restriction) =>
        restriction.enabled && restriction.approvalMode !== "deny",
    );
  const projectEnabled =
    environmentEnabled &&
    (projectApp?.enabled ?? false) &&
    projectPolicy.enabled &&
    projectPolicy.approvalMode !== "deny";

  const environmentAuthority: BrowserEnvironmentDomainAuthorityV1 = {
    version: BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION,
    environmentId: input.environmentId,
    revision: hashCanonical({
      enabled: environmentEnabled,
      settings: environmentSettings,
      policyUpdatedAt: environmentPolicy.updatedAt.toISOString(),
      subjectRestrictions: subjectRestrictions
        .map((restriction) => ({
          subjectType: restriction.subjectType,
          subjectId: restriction.subjectId,
          enabled: restriction.enabled,
          approvalMode: restriction.approvalMode,
          updatedAt: restriction.updatedAt.toISOString(),
        }))
        .sort((left, right) =>
          `${left.subjectType}:${left.subjectId}`.localeCompare(
            `${right.subjectType}:${right.subjectId}`,
          ),
        ),
    }),
    enabledModes: environmentEnabled ? environmentSettings.enabledModes : [],
    personalGrantsEnabled:
      environmentEnabled && environmentSettings.personalGrantsEnabled,
    configuredPublicDomains: environmentSettings.configuredPublicDomains,
    blockedPublicDomains: environmentSettings.blockedPublicDomains,
  };
  const projectAuthority: BrowserProjectDomainAuthorityV1 = {
    version: BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION,
    projectId: input.projectId,
    revision: hashCanonical({
      enabled: projectEnabled,
      projectAppUpdatedAt: projectApp?.updatedAt.toISOString() ?? null,
      settings: projectSettings,
      policyUpdatedAt: projectPolicy.updatedAt.toISOString(),
    }),
    enabledModes: projectEnabled ? projectSettings.enabledModes : [],
    personalGrantsEnabled:
      projectEnabled && projectSettings.personalGrantsEnabled,
    blockedPublicDomains: projectSettings.blockedPublicDomains,
  };
  const personalAuthority: BrowserPersonalDomainAuthorityV1 = {
    version: BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
    userId: input.userId,
    environmentId: input.environmentId,
    revision: String(revisionSet?.revision ?? 0),
    activeDomains: domains.map((domain) =>
      parseStoredPublicDomain(
        { version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION, ...domain },
        "stored personal Browser domain",
      ),
    ),
  };
  return {
    environment: environmentAuthority,
    project: projectAuthority,
    personal: personalAuthority,
    qa: input.qa,
  };
}

export async function resolveHostedBrowserDomainAuthority(
  input: Parameters<typeof readHostedBrowserDomainAuthorityInput>[0],
  database: BrowserDomainReader = knowledgeDb,
): Promise<BrowserEffectiveDomainAuthorityV1> {
  return resolveEffectiveBrowserDomainAuthority(
    await readHostedBrowserDomainAuthorityInput(input, database),
  );
}

export async function resolveHostedBrowserPublicGrantDecision(
  input: Parameters<typeof readHostedBrowserDomainAuthorityInput>[0] & {
    destination: string;
    sessionMode: BrowserMode;
  },
  database: BrowserDomainReader = knowledgeDb,
): Promise<BrowserPublicGrantDecisionV1> {
  return resolveBrowserPublicGrantDecision(
    await readHostedBrowserDomainAuthorityInput(input, database),
    input.destination,
    input.sessionMode,
  );
}

export async function listHostedBrowserPersonalDomains(
  input: { organizationId: string; environmentId: string; userId: string },
  database: BrowserDomainReader = knowledgeDb,
): Promise<readonly HostedBrowserPersonalDomainSummary[]> {
  requireScopeInput(input);
  const rows = await database.query.browserPersonalDomains.findMany({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.environmentId, input.environmentId),
        equals(table.userId, input.userId),
      ),
    orderBy: (table, { asc }) => [asc(table.canonicalDomain)],
  });
  return rows.map(toPersonalDomainSummary);
}

export async function readHostedBrowserPersonalDomainRevision(
  input: { organizationId: string; environmentId: string; userId: string },
  database: BrowserDomainReader = knowledgeDb,
): Promise<number> {
  requireScopeInput(input);
  const row = await database.query.browserPersonalDomainRevisionSets.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.environmentId, input.environmentId),
        equals(table.userId, input.userId),
      ),
    columns: { revision: true },
  });
  return row?.revision ?? 0;
}

export async function createOrReactivateHostedBrowserPersonalDomain(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
  destination: string;
  approvalId: string;
  sourceInteractionId: string;
  sourcePreparedInvocationId: string;
  approvalAuthorityRevision: string;
  now?: Date | undefined;
}): Promise<HostedBrowserPersonalDomainMutationResult> {
  return knowledgeDb.transaction((transaction) =>
    createOrReactivateHostedBrowserPersonalDomainInTransaction(
      transaction,
      input,
    ),
  );
}

export async function createOrReactivateHostedBrowserPersonalDomainInTransaction(
  transaction: BrowserDomainTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    userId: string;
    destination: string;
    approvalId: string;
    sourceInteractionId: string;
    sourcePreparedInvocationId: string;
    approvalAuthorityRevision: string;
    now?: Date | undefined;
  },
): Promise<HostedBrowserPersonalDomainMutationResult> {
  requireScopeInput(input);
  requireNonEmpty(input.approvalId, "approvalId");
  requireNonEmpty(input.sourceInteractionId, "sourceInteractionId");
  requireNonEmpty(
    input.sourcePreparedInvocationId,
    "sourcePreparedInvocationId",
  );
  requireNonEmpty(input.approvalAuthorityRevision, "approvalAuthorityRevision");
  const authority = canonicalizePublicBrowserDestination(input.destination);
  const now = input.now ?? new Date();
  const revisionSet = await lockPersonalRevisionSet(transaction, input, now);
  const [existing] = await transaction
    .select()
    .from(schema.browserPersonalDomains)
    .where(
      and(
        eq(schema.browserPersonalDomains.organizationId, input.organizationId),
        eq(schema.browserPersonalDomains.environmentId, input.environmentId),
        eq(schema.browserPersonalDomains.userId, input.userId),
        eq(
          schema.browserPersonalDomains.canonicalDomain,
          authority.canonicalDomain,
        ),
      ),
    )
    .limit(1)
    .for("update");
  if (existing?.status === "active") {
    return {
      changed: false,
      personalRevision: revisionSet.revision,
      domain: toPersonalDomainSummary(existing),
    };
  }

  const nextRevision = await bumpPersonalRevision(
    transaction,
    input,
    revisionSet.revision,
    now,
  );
  if (existing) {
    const [reactivated] = await transaction
      .update(schema.browserPersonalDomains)
      .set({
        status: "active",
        personalRevision: nextRevision,
        approvalId: input.approvalId,
        sourceInteractionId: input.sourceInteractionId,
        sourcePreparedInvocationId: input.sourcePreparedInvocationId,
        approvalAuthorityRevision: input.approvalAuthorityRevision,
        approvedAt: now,
        revokedAt: null,
        revokedByUserId: null,
        updatedAt: now,
      })
      .where(eq(schema.browserPersonalDomains.id, existing.id))
      .returning();
    if (!reactivated) throw revisionStateError();
    return {
      changed: true,
      personalRevision: nextRevision,
      domain: toPersonalDomainSummary(reactivated),
    };
  }
  const [created] = await transaction
    .insert(schema.browserPersonalDomains)
    .values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      userId: input.userId,
      canonicalDomain: authority.canonicalDomain,
      scheme: authority.scheme,
      includeSubdomains: authority.includeSubdomains,
      port: authority.port,
      status: "active",
      personalRevision: nextRevision,
      approvalId: input.approvalId,
      sourceInteractionId: input.sourceInteractionId,
      sourcePreparedInvocationId: input.sourcePreparedInvocationId,
      approvalAuthorityRevision: input.approvalAuthorityRevision,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!created) throw revisionStateError();
  return {
    changed: true,
    personalRevision: nextRevision,
    domain: toPersonalDomainSummary(created),
  };
}

export async function revokeHostedBrowserPersonalDomain(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
  destination: string;
  now?: Date | undefined;
}): Promise<HostedBrowserPersonalDomainMutationResult> {
  return knowledgeDb.transaction((transaction) =>
    revokeHostedBrowserPersonalDomainInTransaction(transaction, input),
  );
}

export async function revokeHostedBrowserPersonalDomainInTransaction(
  transaction: BrowserDomainTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    userId: string;
    destination: string;
    now?: Date | undefined;
  },
): Promise<HostedBrowserPersonalDomainMutationResult> {
  requireScopeInput(input);
  const authority = canonicalizePublicBrowserDestination(input.destination);
  const now = input.now ?? new Date();
  const [revisionSet] = await transaction
    .select()
    .from(schema.browserPersonalDomainRevisionSets)
    .where(
      and(
        eq(
          schema.browserPersonalDomainRevisionSets.organizationId,
          input.organizationId,
        ),
        eq(
          schema.browserPersonalDomainRevisionSets.environmentId,
          input.environmentId,
        ),
        eq(schema.browserPersonalDomainRevisionSets.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  if (!revisionSet) {
    return { changed: false, personalRevision: 0, domain: null };
  }
  const [existing] = await transaction
    .select()
    .from(schema.browserPersonalDomains)
    .where(
      and(
        eq(schema.browserPersonalDomains.organizationId, input.organizationId),
        eq(schema.browserPersonalDomains.environmentId, input.environmentId),
        eq(schema.browserPersonalDomains.userId, input.userId),
        eq(
          schema.browserPersonalDomains.canonicalDomain,
          authority.canonicalDomain,
        ),
      ),
    )
    .limit(1)
    .for("update");
  if (!existing || existing.status === "revoked") {
    return {
      changed: false,
      personalRevision: revisionSet.revision,
      domain: existing ? toPersonalDomainSummary(existing) : null,
    };
  }
  const nextRevision = await bumpPersonalRevision(
    transaction,
    input,
    revisionSet.revision,
    now,
  );
  const [revoked] = await transaction
    .update(schema.browserPersonalDomains)
    .set({
      status: "revoked",
      personalRevision: nextRevision,
      revokedAt: now,
      revokedByUserId: input.userId,
      updatedAt: now,
    })
    .where(eq(schema.browserPersonalDomains.id, existing.id))
    .returning();
  if (!revoked) throw revisionStateError();
  return {
    changed: true,
    personalRevision: nextRevision,
    domain: toPersonalDomainSummary(revoked),
  };
}

async function lockPersonalRevisionSet(
  transaction: BrowserDomainTransaction,
  input: { organizationId: string; environmentId: string; userId: string },
  now: Date,
) {
  await transaction
    .insert(schema.browserPersonalDomainRevisionSets)
    .values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      userId: input.userId,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        schema.browserPersonalDomainRevisionSets.organizationId,
        schema.browserPersonalDomainRevisionSets.environmentId,
        schema.browserPersonalDomainRevisionSets.userId,
      ],
    });
  const [revisionSet] = await transaction
    .select()
    .from(schema.browserPersonalDomainRevisionSets)
    .where(
      and(
        eq(
          schema.browserPersonalDomainRevisionSets.organizationId,
          input.organizationId,
        ),
        eq(
          schema.browserPersonalDomainRevisionSets.environmentId,
          input.environmentId,
        ),
        eq(schema.browserPersonalDomainRevisionSets.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  if (!revisionSet) throw revisionStateError();
  return revisionSet;
}

async function bumpPersonalRevision(
  transaction: BrowserDomainTransaction,
  input: { organizationId: string; environmentId: string; userId: string },
  currentRevision: number,
  now: Date,
): Promise<number> {
  const nextRevision = currentRevision + 1;
  const [updated] = await transaction
    .update(schema.browserPersonalDomainRevisionSets)
    .set({ revision: nextRevision, updatedAt: now })
    .where(
      and(
        eq(
          schema.browserPersonalDomainRevisionSets.organizationId,
          input.organizationId,
        ),
        eq(
          schema.browserPersonalDomainRevisionSets.environmentId,
          input.environmentId,
        ),
        eq(schema.browserPersonalDomainRevisionSets.userId, input.userId),
        eq(schema.browserPersonalDomainRevisionSets.revision, currentRevision),
      ),
    )
    .returning({ revision: schema.browserPersonalDomainRevisionSets.revision });
  if (!updated || updated.revision !== nextRevision) throw revisionStateError();
  return nextRevision;
}

function parseModes(value: unknown, field: string): BrowserMode[] {
  if (!Array.isArray(value)) settingsError(`${field} must be an array.`);
  const modes = value.map((mode) => {
    if (mode !== "qa" && mode !== "operator") {
      settingsError(`${field} must contain only qa or operator.`);
    }
    return mode;
  });
  if (new Set(modes).size !== modes.length) {
    settingsError(`${field} cannot contain duplicates.`);
  }
  return modes.slice().sort();
}

function parsePublicDomains(
  value: unknown,
  field: string,
): BrowserPublicDomainAuthorityV1[] {
  if (!Array.isArray(value)) settingsError(`${field} must be an array.`);
  const domains = value.map((entry, index) =>
    parseStoredPublicDomain(entry, `${field}[${index}]`),
  );
  if (
    new Set(domains.map((domain) => domain.canonicalDomain)).size !==
    domains.length
  ) {
    settingsError(`${field} cannot contain duplicates.`);
  }
  return domains.sort((left, right) =>
    left.canonicalDomain.localeCompare(right.canonicalDomain),
  );
}

function parseStoredPublicDomain(
  value: unknown,
  field: string,
): BrowserPublicDomainAuthorityV1 {
  const record = exactRecord(
    value,
    ["version", "scheme", "canonicalDomain", "includeSubdomains", "port"],
    field,
  );
  if (
    record.version !== BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION ||
    record.scheme !== "https" ||
    record.includeSubdomains !== true ||
    record.port !== 443 ||
    typeof record.canonicalDomain !== "string"
  ) {
    settingsError(`${field} is not canonical public Browser authority.`);
  }
  const canonical = canonicalizePublicBrowserDestination(
    `https://${record.canonicalDomain}`,
  );
  if (canonical.canonicalDomain !== record.canonicalDomain) {
    settingsError(`${field}.canonicalDomain is not canonical.`);
  }
  return canonical;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    settingsError(`${field} must be an object.`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    settingsError(`${field} must contain exactly ${expected.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}

function isEmptyRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") settingsError(`${field} must be a boolean.`);
  return value;
}

function toPersonalDomainSummary(value: {
  canonicalDomain: string;
  scheme: "https";
  includeSubdomains: boolean;
  port: number;
  status: "active" | "revoked";
  personalRevision: number;
  approvedAt: Date;
  revokedAt: Date | null;
}): HostedBrowserPersonalDomainSummary {
  const authority = parseStoredPublicDomain(
    {
      version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
      scheme: value.scheme,
      canonicalDomain: value.canonicalDomain,
      includeSubdomains: value.includeSubdomains,
      port: value.port,
    },
    "stored personal Browser domain",
  );
  return {
    canonicalDomain: authority.canonicalDomain,
    scheme: authority.scheme,
    includeSubdomains: authority.includeSubdomains,
    port: authority.port,
    status: value.status,
    personalRevision: value.personalRevision,
    approvedAt: value.approvedAt,
    revokedAt: value.revokedAt,
  };
}

function requireScopeInput(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
}): void {
  requireNonEmpty(input.organizationId, "organizationId");
  requireNonEmpty(input.environmentId, "environmentId");
  requireNonEmpty(input.userId, "userId");
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HostedBrowserDomainError(
      "BROWSER_DOMAIN_SETTINGS_INVALID",
      `${field} must be a non-empty string.`,
    );
  }
}

function settingsError(message: string): never {
  throw new HostedBrowserDomainError(
    "BROWSER_DOMAIN_SETTINGS_INVALID",
    message,
  );
}

function revisionStateError(): HostedBrowserDomainError {
  return new HostedBrowserDomainError(
    "BROWSER_DOMAIN_REVISION_STATE_INVALID",
    "The personal Browser domain revision could not be advanced.",
  );
}
