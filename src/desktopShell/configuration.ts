import { AGENT_MODEL_CONFIG_STAGES } from "../../agents/reference-react/src/stageModelConfig.js";
import {
  getKestrelStandardAppManifest,
  KESTREL_APP_IDS,
  KESTREL_STANDARD_APP_MANIFESTS,
  type KestrelAppId,
} from "@kestrel-agents/protocol";
import type { ModelPolicyV1 } from "../profile/modelPolicy.js";
import type { ModelProviderId } from "../profile/runtimeProfile.js";
import { getDesktopStandardAppConnection } from "./standardAppConnections.js";

export const DESKTOP_DEFAULT_MODEL_CONFIGURATION_ID = "desktop-default";
export const DESKTOP_WEATHER_APP_ID = KESTREL_APP_IDS.WEATHER;
export const DESKTOP_LEGACY_WEATHER_APP_ID = "weather";
export const DESKTOP_INITIAL_CONFIGURATION_CREATED_AT =
  "1970-01-01T00:00:00.000Z";
export const DESKTOP_DEFAULT_ENABLED_APP_IDS = Object.freeze([
  KESTREL_APP_IDS.WEATHER,
  KESTREL_APP_IDS.TIME,
  KESTREL_APP_IDS.GEOCODING,
  KESTREL_APP_IDS.EXCHANGE_RATES,
]);

export interface DesktopModelConfigurationRevision {
  revision: number;
  createdAt: string;
  policy: ModelPolicyV1;
}

export interface DesktopModelConfiguration {
  id: string;
  name: string;
  currentRevision: number;
  revisions: DesktopModelConfigurationRevision[];
  archivedAt?: string | undefined;
}

export interface DesktopModelConfigurationRef {
  id: string;
  revision: number;
}

export interface DesktopAppRef {
  id: string;
  contractVersion: number;
}

export interface DesktopExecutionSelection {
  modelConfiguration: DesktopModelConfigurationRef;
  apps: DesktopAppRef[];
}

export interface DesktopAppDefinition {
  id: string;
  contractVersion: number;
  label: string;
  description: string;
  toolNames: string[];
}

export interface DesktopCustomAppDefinitionSource {
  id: string;
  appId?: string | undefined;
  name: string;
  enabled: boolean;
  tools?: Array<{ name: string; description?: string | undefined }> | undefined;
  capabilityPacks?: string[] | undefined;
}

function isNativeStandardApp(app: DesktopCustomAppDefinitionSource): boolean {
  if (app.appId === undefined) return false;
  const connection = getDesktopStandardAppConnection(app.appId);
  return connection?.kind === "authorization" && connection.runtime === "native";
}

export {
  getDesktopStandardAppConnection,
  listDesktopStandardAppConnections,
  type DesktopStandardAppConnectionDefinition,
} from "./standardAppConnections.js";

export function isPublishedStandardAppId(appId: string): appId is KestrelAppId {
  return KESTREL_STANDARD_APP_MANIFESTS.some((app) => app.id === appId);
}

export function desktopAppIdForServer(
  server: DesktopCustomAppDefinitionSource,
): string {
  return server.appId !== undefined && isPublishedStandardAppId(server.appId)
    ? server.appId
    : desktopCustomAppId(server.id);
}

const DESKTOP_APP_DEFINITIONS: readonly DesktopAppDefinition[] = Object.freeze([
  Object.freeze({
    id: DESKTOP_WEATHER_APP_ID,
    contractVersion: 1,
    label: "Weather",
    description: "Current conditions and forecasts.",
    toolNames: Object.freeze([
      "free.weather.current",
      "free.weather.forecast",
    ]) as unknown as string[],
  }),
  Object.freeze({
    id: KESTREL_APP_IDS.TIME,
    contractVersion: 1,
    label: "Time",
    description: "Current time in any timezone.",
    toolNames: Object.freeze(["free.time.current"]) as unknown as string[],
  }),
  Object.freeze({
    id: KESTREL_APP_IDS.GEOCODING,
    contractVersion: 1,
    label: "Geocoding",
    description: "Resolve place names to geographic coordinates.",
    toolNames: Object.freeze(["free.geocode.lookup"]) as unknown as string[],
  }),
  Object.freeze({
    id: KESTREL_APP_IDS.EXCHANGE_RATES,
    contractVersion: 1,
    label: "Exchange Rates",
    description: "Current reference exchange rates for world currencies.",
    toolNames: Object.freeze(["free.exchange.rate"]) as unknown as string[],
  }),
  Object.freeze({
    id: KESTREL_APP_IDS.TAVILY,
    contractVersion: 1,
    label: "Tavily",
    description: "Search, extract, crawl, map, and research the web.",
    toolNames: Object.freeze([
      "internet.search",
      "internet.search_advanced",
      "internet.news",
      "internet.images",
      "internet.extract",
      "internet.crawl",
      "internet.map",
      "internet.research",
      "internet.research_status",
      "internet.usage",
    ]) as unknown as string[],
  }),
  ...KESTREL_STANDARD_APP_MANIFESTS.filter(
    (manifest) => manifest.category === "workflow",
  ).map((manifest) =>
    Object.freeze({
      id: manifest.id,
      contractVersion: 1,
      label: manifest.name,
      description: manifest.description,
      toolNames: Object.freeze([]) as unknown as string[],
    }),
  ),
]);

export interface DesktopWorkflowDependencyStatus {
  role: string;
  minimum: number;
  readyAppIds: KestrelAppId[];
  missing: boolean;
}

export interface DesktopWorkflowSelectionStatus {
  appId: KestrelAppId;
  name: string;
  instructions: string;
  dependencies: DesktopWorkflowDependencyStatus[];
  ready: boolean;
}

export function resolveDesktopWorkflowSelections(
  selection: DesktopExecutionSelection,
  customApps: readonly DesktopCustomAppDefinitionSource[] = [],
): DesktopWorkflowSelectionStatus[] {
  const selectedAppIds = new Set(
    selection.apps.map((app) => normalizeDesktopAppId(app.id)),
  );
  const executableAppIds = new Set<string>();
  const capabilityPacksByAppId = new Map<string, Set<string>>();
  for (const app of customApps) {
    if (app.enabled && (app.tools?.length ?? 0) > 0) {
      const appId = desktopAppIdForServer(app);
      executableAppIds.add(appId);
      const manifest = isPublishedStandardAppId(appId)
        ? getKestrelStandardAppManifest(appId)
        : undefined;
      capabilityPacksByAppId.set(
        appId,
        new Set(
          app.capabilityPacks ??
            manifest?.capabilityPacks.map((pack) => pack.key) ??
            [],
        ),
      );
    }
  }
  const selectedExecutableAppIds = new Set(
    [...selectedAppIds].filter((appId) => executableAppIds.has(appId)),
  );

  return KESTREL_STANDARD_APP_MANIFESTS.filter(
    (manifest) =>
      manifest.category === "workflow" && selectedAppIds.has(manifest.id),
  ).map((manifest) => {
    const dependencies = (manifest.dependencies ?? []).map((dependency) => {
      const readyAppIds = dependency.appIds.filter((appId) => {
        if (!selectedExecutableAppIds.has(appId)) return false;
        const requiredPacks = dependency.requiredCapabilityPacks?.[appId];
        if (!requiredPacks?.length) return true;
        const configuredPacks = capabilityPacksByAppId.get(appId);
        return requiredPacks.some((pack) => configuredPacks?.has(pack));
      });
      return {
        role: dependency.role,
        minimum: dependency.minimum,
        readyAppIds,
        missing: readyAppIds.length < dependency.minimum,
      };
    });
    return {
      appId: manifest.id,
      name: manifest.name,
      instructions: manifest.workflowInstructions ?? manifest.description,
      dependencies,
      ready: dependencies.every((dependency) => !dependency.missing),
    };
  });
}

export function formatDesktopWorkflowInstructions(
  workflows: readonly DesktopWorkflowSelectionStatus[],
): string | undefined {
  if (workflows.length === 0) return undefined;
  return [
    "## Enabled Workflow Apps",
    "These workflows coordinate only the App capabilities selected for this conversation. They do not grant additional access or change any App approval requirement.",
    ...workflows.map((workflow) => {
      const dependencies = workflow.dependencies
        .map((dependency) => {
          const names = dependency.readyAppIds
            .map((appId) => getKestrelStandardAppManifest(appId)?.name ?? appId)
            .join(" or ");
          return `${dependency.role}: ${names}`;
        })
        .join("; ");
      return `- ${workflow.name}: ${workflow.instructions} Available Apps: ${dependencies}.`;
    }),
  ].join("\n");
}

export function desktopCustomAppId(serverId: string): string {
  return `custom.${serverId}`;
}

export function listDesktopAppDefinitions(
  customApps: readonly DesktopCustomAppDefinitionSource[] = [],
): DesktopAppDefinition[] {
  return [
    ...DESKTOP_APP_DEFINITIONS,
    ...customApps.map((app) => {
      const appId = desktopAppIdForServer(app);
      const manifest = isPublishedStandardAppId(appId)
        ? getKestrelStandardAppManifest(appId)
        : undefined;
      return {
        id: appId,
        contractVersion: 1,
        label: manifest?.name ?? app.name,
        description:
          manifest?.description ??
          (app.enabled
            ? `${app.tools?.length ?? 0} configured capabilities.`
            : "App is currently disabled."),
        toolNames: app.enabled
          ? (app.tools?.map((tool) =>
              isNativeStandardApp(app) ? tool.name : `mcp.${app.id}.${tool.name}`,
            ) ?? [])
          : [],
      };
    }),
  ].map((definition) => ({
    ...definition,
    toolNames: [...definition.toolNames],
  }));
}

export function getDesktopAppDefinition(
  id: string,
  contractVersion?: number,
  customApps: readonly DesktopCustomAppDefinitionSource[] = [],
): DesktopAppDefinition | undefined {
  const definition = listDesktopAppDefinitions(customApps).find(
    (entry) => entry.id === normalizeDesktopAppId(id),
  );
  if (
    definition === undefined ||
    (contractVersion !== undefined &&
      definition.contractVersion !== contractVersion)
  ) {
    return;
  }
  return { ...definition, toolNames: [...definition.toolNames] };
}

export function normalizeDesktopAppId(id: string): string {
  return id === DESKTOP_LEGACY_WEATHER_APP_ID ? DESKTOP_WEATHER_APP_ID : id;
}

export function createDesktopModelConfiguration(
  policy: ModelPolicyV1,
  input: {
    id?: string | undefined;
    name?: string | undefined;
    createdAt?: string | undefined;
  } = {},
): DesktopModelConfiguration {
  return {
    id: input.id ?? DESKTOP_DEFAULT_MODEL_CONFIGURATION_ID,
    name: input.name ?? "Default",
    currentRevision: 1,
    revisions: [
      {
        revision: 1,
        createdAt: input.createdAt ?? DESKTOP_INITIAL_CONFIGURATION_CREATED_AT,
        policy: parseDesktopModelPolicy(policy),
      },
    ],
  };
}

export function parseDesktopModelConfigurations(
  value: unknown,
): DesktopModelConfiguration[] {
  if (Array.isArray(value) === false) {
    throw new Error("Desktop model configurations must be an array.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const record = requireRecord(entry, `modelConfigurations[${index}]`);
    const id = requireString(record.id, `modelConfigurations[${index}].id`);
    if (ids.has(id)) {
      throw new Error(`Desktop model configuration '${id}' is duplicated.`);
    }
    ids.add(id);
    const revisionsValue = record.revisions;
    if (
      Array.isArray(revisionsValue) === false ||
      revisionsValue.length === 0
    ) {
      throw new Error(
        `Desktop model configuration '${id}' must have revisions.`,
      );
    }
    const revisionNumbers = new Set<number>();
    const revisions = revisionsValue
      .map((revisionValue, revisionIndex) => {
        const revisionRecord = requireRecord(
          revisionValue,
          `modelConfigurations[${index}].revisions[${revisionIndex}]`,
        );
        const revision = requirePositiveInteger(
          revisionRecord.revision,
          `modelConfigurations[${index}].revisions[${revisionIndex}].revision`,
        );
        if (revisionNumbers.has(revision)) {
          throw new Error(
            `Desktop model configuration '${id}' has duplicate revision ${revision}.`,
          );
        }
        revisionNumbers.add(revision);
        return {
          revision,
          createdAt: requireString(
            revisionRecord.createdAt,
            `modelConfigurations[${index}].revisions[${revisionIndex}].createdAt`,
          ),
          policy: parseDesktopModelPolicy(revisionRecord.policy),
        };
      })
      .sort((left, right) => left.revision - right.revision);
    const currentRevision = requirePositiveInteger(
      record.currentRevision,
      `modelConfigurations[${index}].currentRevision`,
    );
    if (revisionNumbers.has(currentRevision) === false) {
      throw new Error(
        `Desktop model configuration '${id}' current revision is missing.`,
      );
    }
    return {
      id,
      name: requireString(record.name, `modelConfigurations[${index}].name`),
      currentRevision,
      revisions,
      ...(typeof record.archivedAt === "string" &&
      record.archivedAt.trim().length > 0
        ? { archivedAt: record.archivedAt.trim() }
        : {}),
    };
  });
}

export function resolveDesktopModelConfiguration(
  configurations: readonly DesktopModelConfiguration[],
  reference: DesktopModelConfigurationRef,
):
  | {
      configuration: DesktopModelConfiguration;
      revision: DesktopModelConfigurationRevision;
    }
  | undefined {
  const configuration = configurations.find(
    (entry) => entry.id === reference.id,
  );
  const revision = configuration?.revisions.find(
    (entry) => entry.revision === reference.revision,
  );
  return configuration === undefined || revision === undefined
    ? undefined
    : { configuration, revision };
}

export function currentDesktopModelConfigurationRef(
  configuration: DesktopModelConfiguration,
): DesktopModelConfigurationRef {
  return { id: configuration.id, revision: configuration.currentRevision };
}

export function appendDesktopModelConfigurationRevision(
  configuration: DesktopModelConfiguration,
  policy: ModelPolicyV1,
  createdAt = new Date().toISOString(),
): DesktopModelConfiguration {
  const revision =
    Math.max(...configuration.revisions.map((entry) => entry.revision)) + 1;
  return {
    ...configuration,
    currentRevision: revision,
    revisions: [
      ...configuration.revisions,
      {
        revision,
        createdAt,
        policy: parseDesktopModelPolicy(policy),
      },
    ],
  };
}

export function assertDesktopModelConfigurationHistoryPreserved(
  previous: readonly DesktopModelConfiguration[],
  next: readonly DesktopModelConfiguration[],
): void {
  const nextById = new Map(
    next.map((configuration) => [configuration.id, configuration]),
  );
  for (const previousConfiguration of previous) {
    const nextConfiguration = nextById.get(previousConfiguration.id);
    if (nextConfiguration === undefined) {
      throw new Error(
        `Desktop model configuration '${previousConfiguration.id}' cannot be removed; archive it instead.`,
      );
    }
    if (
      previousConfiguration.archivedAt !== undefined &&
      nextConfiguration.archivedAt !== previousConfiguration.archivedAt
    ) {
      throw new Error(
        `Desktop model configuration '${previousConfiguration.id}' cannot be unarchived or re-archived.`,
      );
    }
    for (const previousRevision of previousConfiguration.revisions) {
      const nextRevision = nextConfiguration.revisions.find(
        (revision) => revision.revision === previousRevision.revision,
      );
      if (
        nextRevision === undefined ||
        revisionsEqual(previousRevision, nextRevision) === false
      ) {
        throw new Error(
          `Desktop model configuration '${previousConfiguration.id}' revision ${previousRevision.revision} is immutable.`,
        );
      }
    }
    const highestPreviousRevision = Math.max(
      ...previousConfiguration.revisions.map((revision) => revision.revision),
    );
    const addedRevisions = nextConfiguration.revisions.filter(
      (revision) => revision.revision > highestPreviousRevision,
    );
    addedRevisions.forEach((revision, index) => {
      const expectedRevision = highestPreviousRevision + index + 1;
      if (revision.revision !== expectedRevision) {
        throw new Error(
          `Desktop model configuration '${previousConfiguration.id}' revisions must be appended in order.`,
        );
      }
    });
    if (
      addedRevisions.length > 0 &&
      nextConfiguration.currentRevision !== addedRevisions.at(-1)!.revision
    ) {
      throw new Error(
        `Desktop model configuration '${previousConfiguration.id}' must select its latest appended revision.`,
      );
    }
  }

  for (const nextConfiguration of next) {
    if (
      previous.some(
        (configuration) => configuration.id === nextConfiguration.id,
      ) === false &&
      (nextConfiguration.currentRevision !== 1 ||
        nextConfiguration.revisions.length !== 1 ||
        nextConfiguration.revisions[0]?.revision !== 1)
    ) {
      throw new Error(
        `Desktop model configuration '${nextConfiguration.id}' must begin at revision 1.`,
      );
    }
  }
}

export function parseDesktopExecutionSelection(
  value: unknown,
): DesktopExecutionSelection {
  const record = requireRecord(value, "executionSelection");
  const model = requireRecord(
    record.modelConfiguration,
    "executionSelection.modelConfiguration",
  );
  if (Array.isArray(record.apps) === false) {
    throw new Error("executionSelection.apps must be an array.");
  }
  const seen = new Set<string>();
  const apps = record.apps
    .map((entry, index) => {
      const app = requireRecord(entry, `executionSelection.apps[${index}]`);
      const id = normalizeDesktopAppId(
        requireString(app.id, `executionSelection.apps[${index}].id`),
      );
      if (seen.has(id)) {
        throw new Error(`executionSelection app '${id}' is duplicated.`);
      }
      seen.add(id);
      return {
        id,
        contractVersion: requirePositiveInteger(
          app.contractVersion,
          `executionSelection.apps[${index}].contractVersion`,
        ),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    modelConfiguration: {
      id: requireString(model.id, "executionSelection.modelConfiguration.id"),
      revision: requirePositiveInteger(
        model.revision,
        "executionSelection.modelConfiguration.revision",
      ),
    },
    apps,
  };
}

export function providerOfConfiguration(
  configuration: DesktopModelConfiguration,
): ModelProviderId {
  return configuration.revisions.find(
    (entry) => entry.revision === configuration.currentRevision,
  )!.policy.provider;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseDesktopModelPolicy(value: unknown): ModelPolicyV1 {
  const record = requireRecord(value, "model policy");
  const supportedFields = new Set([
    "version",
    "provider",
    "model",
    "modelByStage",
    "modelTimeoutMs",
    "modelCapabilities",
  ]);
  const unsupported = Object.keys(record).find(
    (key) => supportedFields.has(key) === false,
  );
  if (unsupported !== undefined || record.version !== 1) {
    throw new Error(
      unsupported === undefined
        ? "model policy version must be 1."
        : `model policy field '${unsupported}' is unsupported.`,
    );
  }
  const provider = record.provider;
  if (
    provider !== "openrouter" &&
    provider !== "openai" &&
    provider !== "anthropic" &&
    provider !== "ollama" &&
    provider !== "lmstudio"
  ) {
    throw new Error("model policy provider is invalid.");
  }
  const modelByStageRecord = requireRecord(
    record.modelByStage,
    "model policy modelByStage",
  );
  const allowedStages = new Set<string>(
    AGENT_MODEL_CONFIG_STAGES.map((stage) => stage.stageId),
  );
  const modelByStage: Record<string, string> = {};
  for (const [stageId, model] of Object.entries(modelByStageRecord)) {
    if (allowedStages.has(stageId) === false) {
      throw new Error(`model policy stage '${stageId}' is unsupported.`);
    }
    modelByStage[stageId] = requireString(
      model,
      `model policy modelByStage.${stageId}`,
    );
  }
  const capabilities = requireRecord(
    record.modelCapabilities,
    "model policy modelCapabilities",
  );
  if (
    Object.keys(capabilities).some((key) => key !== "visionInputEnabled") ||
    typeof capabilities.visionInputEnabled !== "boolean"
  ) {
    throw new Error("model policy modelCapabilities is invalid.");
  }
  const timeout = record.modelTimeoutMs;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      Number.isSafeInteger(timeout) === false ||
      timeout <= 0)
  ) {
    throw new Error("model policy modelTimeoutMs must be a positive integer.");
  }
  return {
    version: 1,
    provider,
    model: requireString(record.model, "model policy model"),
    modelByStage,
    ...(typeof timeout === "number" ? { modelTimeoutMs: timeout } : {}),
    modelCapabilities: { visionInputEnabled: capabilities.visionInputEnabled },
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    Number.isSafeInteger(value) === false ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function revisionsEqual(
  left: DesktopModelConfigurationRevision,
  right: DesktopModelConfigurationRevision,
): boolean {
  return (
    left.revision === right.revision &&
    left.createdAt === right.createdAt &&
    left.policy.version === right.policy.version &&
    left.policy.provider === right.policy.provider &&
    left.policy.model === right.policy.model &&
    left.policy.modelTimeoutMs === right.policy.modelTimeoutMs &&
    left.policy.modelCapabilities.visionInputEnabled ===
      right.policy.modelCapabilities.visionInputEnabled &&
    recordsEqual(left.policy.modelByStage, right.policy.modelByStage)
  );
}

function recordsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry?.[0] === key && rightEntry[1] === value;
    })
  );
}
