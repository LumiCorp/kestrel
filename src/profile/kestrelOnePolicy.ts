import { createHash } from "node:crypto";

import type { TuiProfile } from "../../cli/contracts.js";
import { DEFAULT_ACT_SUBMODE, DEFAULT_INTERACTION_MODE } from "../mode/contracts.js";
import {
  buildRuntimeIdentityMetadata,
  resolveRuntimeProfileSelection,
  type ShellKind,
  type ShellPresetId,
} from "./runtimeProfile.js";

export const KESTREL_ONE_POLICY_ID = "kestrel-one";
export const KESTREL_ONE_POLICY_LABEL = "Kestrel One";
export const KESTREL_ONE_POLICY_VERSION = 1;
export const KESTREL_ONE_PROMPT_POLICY_ID = "kestrel-one";

export interface KestrelOnePolicyDefinition {
  id: typeof KESTREL_ONE_POLICY_ID;
  version: typeof KESTREL_ONE_POLICY_VERSION;
  promptPolicyId: typeof KESTREL_ONE_PROMPT_POLICY_ID;
  agent: TuiProfile["agent"];
  requiredModelToolNames: readonly string[];
  allowNestedCollaborators: false;
}

export const KESTREL_ONE_DIALOG_TOOL_NAMES = Object.freeze([
  "dialog.open",
  "dialog.send",
  "dialog.close",
] as const);

export const KESTREL_ONE_POLICY: Readonly<KestrelOnePolicyDefinition> =
  Object.freeze({
    id: KESTREL_ONE_POLICY_ID,
    version: KESTREL_ONE_POLICY_VERSION,
    promptPolicyId: KESTREL_ONE_PROMPT_POLICY_ID,
    agent: "reference-react",
    requiredModelToolNames: KESTREL_ONE_DIALOG_TOOL_NAMES,
    allowNestedCollaborators: false,
  });

export const KESTREL_ONE_INTERNAL_DELEGATION_TOOL_NAMES = Object.freeze([
  "agent.spawn",
  "delegate.spawn_child",
  "delegate.list_children",
  "delegate.get_child_result",
] as const);

export const KESTREL_ONE_WORKSPACE_TOOL_NAMES = Object.freeze([
  "kestrel_one.search_knowledge_documents",
  "kestrel_one.github_repository_read",
  "kestrel_one.github_push_agent_branch",
  "workspace.preview.publish",
  "workspace.preview.list",
  "workspace.preview.renew",
  "workspace.preview.close",
  "kestrel_one.github_issue_create",
  "kestrel_one.github_pull_request_create",
  "kestrel_one.github_pull_request_merge",
  "kestrel_one.github_release_create",
  "kestrel_one.github_workflow_dispatch",
  "kestrel_one.google_calendar_list_events",
  "kestrel_one.google_calendar_create_event",
  "kestrel_one.google_calendar_update_event",
  "kestrel_one.google_calendar_delete_event",
  "kestrel_one.google_calendar_list_availability_subjects",
  "kestrel_one.google_calendar_check_availability",
  "kestrel_one.microsoft_365_list_mail",
  "kestrel_one.microsoft_365_send_mail",
  "kestrel_one.microsoft_365_list_events",
  "kestrel_one.microsoft_365_list_chats",
  "kestrel_one.microsoft_365_send_chat_message",
  "kestrel_one.microsoft_365_search_sites",
  "kestrel_one.vercel_list_projects",
  "kestrel_one.vercel_list_deployments",
  "kestrel_one.vercel_deployment_events",
] as const);

const INTERNAL_TOOL_NAMES = new Set<string>(
  KESTREL_ONE_INTERNAL_DELEGATION_TOOL_NAMES,
);

const DEFAULT_TOOL_QUEUE = Object.freeze({
  perRunConcurrency: 8,
  globalConcurrency: 24,
  maxQueuedJobsPerRun: 50,
  checkpointSize: 10,
  retryCount: 1,
});

export interface KestrelOnePolicyProvenance {
  policyId: typeof KESTREL_ONE_POLICY_ID;
  policyVersion: typeof KESTREL_ONE_POLICY_VERSION;
  promptPolicyId: typeof KESTREL_ONE_PROMPT_POLICY_ID;
  environmentPresetId: Exclude<ShellPresetId, "web_balanced">;
  environmentPresetVersion: number;
  fingerprint: string;
}

export interface KestrelOneEnvironmentPresetDefinition {
  id: Exclude<ShellPresetId, "web_balanced">;
  version: number;
}

export const KESTREL_ONE_ENVIRONMENT_PRESETS: Readonly<
  Record<
    KestrelOneEnvironmentPresetDefinition["id"],
    Readonly<KestrelOneEnvironmentPresetDefinition>
  >
> = Object.freeze({
  cli_dev_local: Object.freeze({ id: "cli_dev_local", version: 1 }),
  desktop_dev_local: Object.freeze({
    id: "desktop_dev_local",
    version: 1,
  }),
  workspace_hosted: Object.freeze({ id: "workspace_hosted", version: 1 }),
});

export interface KestrelOneProfileOverlay {
  label?: string | undefined;
  modelProvider?: TuiProfile["modelProvider"] | undefined;
  model?: string | undefined;
  modelCredential?: TuiProfile["modelCredential"] | undefined;
  modelCapabilities?: TuiProfile["modelCapabilities"] | undefined;
  harnessEconomicsPolicy?: TuiProfile["harnessEconomicsPolicy"] | undefined;
  modelEconomicsProfile?: TuiProfile["modelEconomicsProfile"] | undefined;
  agentStageConfig?: TuiProfile["agentStageConfig"] | undefined;
  modelTimeoutMs?: number | undefined;
  storeDriver?: TuiProfile["storeDriver"] | undefined;
  approvalPolicyPackId?: TuiProfile["approvalPolicyPackId"] | undefined;
  kestrelOneAppApprovalModes?: TuiProfile["kestrelOneAppApprovalModes"] | undefined;
  additionalToolNames?: string[] | undefined;
  mcpServers?: TuiProfile["mcpServers"] | undefined;
  toolQueue?: TuiProfile["toolQueue"] | undefined;
  codeMode?: TuiProfile["codeMode"] | undefined;
  devShell?: TuiProfile["devShell"] | undefined;
  delegationLimits?:
    | Pick<
        NonNullable<TuiProfile["delegation"]>,
        "maxConcurrentChildSessions" | "maxDepth"
      >
    | undefined;
  reasoning?: TuiProfile["reasoning"] | undefined;
  theme?: TuiProfile["theme"] | undefined;
  default?: boolean | undefined;
}

export interface ComposeKestrelOneProfileInput {
  environmentPresetId: Exclude<ShellPresetId, "web_balanced">;
  overlay?: KestrelOneProfileOverlay | undefined;
  resolvedProfileId?: string | undefined;
}

export interface ComposedKestrelOneProfile {
  profile: TuiProfile;
  provenance: KestrelOnePolicyProvenance;
}

export function composeKestrelOneProfile(
  input: ComposeKestrelOneProfileInput,
): ComposedKestrelOneProfile {
  const environmentPreset =
    KESTREL_ONE_ENVIRONMENT_PRESETS[input.environmentPresetId];
  const shellKind = shellKindForPreset(input.environmentPresetId);
  const resolvedEnvironment = resolveRuntimeProfileSelection({
    shellKind,
    presetId: input.environmentPresetId,
    codeMode: input.overlay?.codeMode,
    devShell: input.overlay?.devShell,
  });
  const runtimeIdentity = buildRuntimeIdentityMetadata({
    agentProfileId: KESTREL_ONE_POLICY_ID,
    agentProfileLabel: KESTREL_ONE_POLICY_LABEL,
    shellKind,
    presetId: input.environmentPresetId,
    capabilityPacks: resolvedEnvironment.capabilityPacks,
  });
  const additionalToolNames = [
    ...(input.environmentPresetId === "workspace_hosted"
      ? KESTREL_ONE_WORKSPACE_TOOL_NAMES
      : []),
    ...(input.overlay?.additionalToolNames ?? []),
  ];
  const toolAllowlist = normalizeKestrelOneToolAllowlist([
    ...resolvedEnvironment.toolAllowlist,
    ...additionalToolNames,
    ...KESTREL_ONE_DIALOG_TOOL_NAMES,
  ]);
  assertRequiredKestrelOneTools(toolAllowlist);

  const fingerprint = fingerprintKestrelOneComposition({
    policyId: KESTREL_ONE_POLICY_ID,
    policyVersion: KESTREL_ONE_POLICY_VERSION,
    promptPolicyId: KESTREL_ONE_PROMPT_POLICY_ID,
    environmentPresetId: input.environmentPresetId,
    environmentPresetVersion: environmentPreset.version,
    environmentCapabilityPacks: resolvedEnvironment.capabilityPacks,
    overlay: input.overlay ?? {},
    toolAllowlist,
  });
  const profileId =
    input.resolvedProfileId ??
    (input.environmentPresetId === "workspace_hosted"
      ? KESTREL_ONE_POLICY_ID
      : `${KESTREL_ONE_POLICY_ID}:${input.environmentPresetId}:${fingerprint}`);
  const delegationLimits = input.overlay?.delegationLimits;
  const profile: TuiProfile = {
    id: profileId,
    label: input.overlay?.label ?? KESTREL_ONE_POLICY_LABEL,
    agent: "reference-react",
    sessionPrefix: KESTREL_ONE_POLICY_ID,
    agentProfileId: runtimeIdentity.agentProfileId,
    agentProfileLabel: runtimeIdentity.agentProfileLabel,
    shellKind,
    presetId: input.environmentPresetId,
    capabilityPacks: [...resolvedEnvironment.capabilityPacks],
    environmentShellKind: runtimeIdentity.environmentShellKind,
    environmentPresetId: runtimeIdentity.environmentPresetId,
    environmentCapabilityPackIds: [
      ...runtimeIdentity.environmentCapabilityPackIds,
    ],
    modelProvider: input.overlay?.modelProvider ?? "openrouter",
    ...(input.overlay?.model !== undefined
      ? { model: input.overlay.model }
      : {}),
    ...(input.overlay?.modelCredential !== undefined
      ? { modelCredential: input.overlay.modelCredential }
      : {}),
    ...(input.overlay?.modelCapabilities !== undefined
      ? { modelCapabilities: input.overlay.modelCapabilities }
      : {}),
    ...(input.overlay?.harnessEconomicsPolicy !== undefined
      ? { harnessEconomicsPolicy: input.overlay.harnessEconomicsPolicy }
      : {}),
    ...(input.overlay?.modelEconomicsProfile !== undefined
      ? { modelEconomicsProfile: input.overlay.modelEconomicsProfile }
      : {}),
    ...(input.overlay?.agentStageConfig !== undefined
      ? { agentStageConfig: input.overlay.agentStageConfig }
      : {}),
    ...(input.overlay?.modelTimeoutMs !== undefined
      ? { modelTimeoutMs: input.overlay.modelTimeoutMs }
      : {}),
    storeDriver: input.overlay?.storeDriver ?? "auto",
    approvalPolicyPackId: input.overlay?.approvalPolicyPackId ?? "dev",
    modeSystemV2Enabled: true,
    defaultInteractionMode: DEFAULT_INTERACTION_MODE,
    defaultActSubmode: DEFAULT_ACT_SUBMODE,
    toolAllowlist,
    ...(input.overlay?.kestrelOneAppApprovalModes !== undefined
      ? {
          kestrelOneAppApprovalModes:
            input.overlay.kestrelOneAppApprovalModes,
        }
      : {}),
    mcpServers: input.overlay?.mcpServers ?? [],
    toolQueue: {
      ...DEFAULT_TOOL_QUEUE,
      ...(input.overlay?.toolQueue ?? {}),
    },
    guardrails: { maxStepVisits: 80 },
    codeMode: resolvedEnvironment.codeMode,
    devShell: resolvedEnvironment.devShell,
    delegation: {
      allowAgentSpawn: true,
      maxConcurrentChildSessions: normalizePositiveInteger(
        delegationLimits?.maxConcurrentChildSessions,
        2,
      ),
      // This remains a compatibility/runtime budget. dialog.open separately
      // rejects collaborator contexts, so nested collaborator creation stays
      // prohibited regardless of this value.
      maxDepth: normalizePositiveInteger(delegationLimits?.maxDepth, 2),
    },
    reasoning: input.overlay?.reasoning ?? {
      request: { mode: "provider_visible" },
      retention: { mode: "live_only", days: 7 },
    },
    ...(input.overlay?.theme !== undefined
      ? { theme: input.overlay.theme }
      : {}),
    ...(input.overlay?.default !== undefined
      ? { default: input.overlay.default }
      : {}),
  };

  return {
    profile,
    provenance: {
      policyId: KESTREL_ONE_POLICY_ID,
      policyVersion: KESTREL_ONE_POLICY_VERSION,
      promptPolicyId: KESTREL_ONE_PROMPT_POLICY_ID,
      environmentPresetId: input.environmentPresetId,
      environmentPresetVersion: environmentPreset.version,
      fingerprint,
    },
  };
}

export function normalizeKestrelOneToolAllowlist(
  toolNames: readonly string[],
): string[] {
  return [
    ...new Set(
      toolNames
        .map((name) => name.trim())
        .filter(
          (name) => name.length > 0 && INTERNAL_TOOL_NAMES.has(name) === false,
        ),
    ),
  ];
}

export function assertRequiredKestrelOneTools(
  toolNames: readonly string[],
): void {
  const available = new Set(toolNames);
  const missing = KESTREL_ONE_DIALOG_TOOL_NAMES.filter(
    (name) => available.has(name) === false,
  );
  if (missing.length > 0) {
    throw new Error(
      `Kestrel One policy is missing required model tools: ${missing.join(", ")}.`,
    );
  }
}

export function fingerprintResolvedProfile(profile: TuiProfile): string {
  return createHash("sha256")
    .update(stableJson(profile))
    .digest("hex");
}

function fingerprintKestrelOneComposition(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(value))
    .digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function shellKindForPreset(
  presetId: ComposeKestrelOneProfileInput["environmentPresetId"],
): ShellKind {
  if (presetId === "desktop_dev_local") return "desktop";
  if (presetId === "workspace_hosted") return "web";
  return "cli";
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
