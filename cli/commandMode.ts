import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_STEP_IDS,
  buildPresentedProviderModelCatalog,
  ModelPolicyStore,
  resolveProviderModelCatalog,
  searchProviderModelCatalog,
  type ToolExecutionClass,
} from "../src/index.js";
import type { ReplayQuery } from "../src/replay/RunReplayService.js";
import type { LocalCoreClient } from "../src/localCore/client.js";
import type { TuiProfile } from "./contracts.js";
import { createConfiguredCliProtocolClient } from "./client/configuredClient.js";
import { toCoreExecutionProfile } from "./client/coreExecutionProfile.js";
import { COMMAND_MODE_COMMANDS } from "./contractMatrix.js";
import { ProfileStore } from "./config/ProfileStore.js";
import {
  readRuntimeSettings,
  writeRuntimeSettings,
  type RuntimeSettingsFile,
} from "./config/RuntimeSettings.js";
import { resolveKestrelHome } from "./config/kestrelHome.js";
import type {
  JobExecutionProfileBindingV1,
  JobInputV1,
  JobInputV2,
  JobOutputV1,
  JobPreflightV1,
  JobRunRejectionV1,
} from "./job/contracts.js";
import { parseJobInput } from "./job/contracts.js";
import {
  digestApprovalPolicyPack,
  getApprovalPolicyPack,
} from "./runtime/approvalPolicyPacks.js";
import type {
  JobRunCommandPayload,
  OperatorControlCommandPayload,
  OperatorControlledEventPayload,
} from "./protocol/contracts.js";
import { extractWaitPrompt } from "../src/runtime/waitForPrompt.js";
import {
  formatDoctorInspection,
  formatReplayInspection,
} from "./runtime/inspectionFormatting.js";
import { runWebCommand } from "./webCommand.js";
import { WorkspaceStore } from "./workspace/WorkspaceStore.js";
import { resolveWorkspaceFromCwd } from "./workspace/WorkspaceResolver.js";
import {
  ensureCliLocalCoreReady,
  formatCliLocalCoreStatus,
  type CliLocalCoreStatus,
} from "./localCoreShell.js";
import {
  formatCliLocalCoreDaemonInspection,
  resolveCliLocalCoreDaemonOptions,
} from "./localCoreShell.js";
import {
  inspectLocalCoreDaemon,
  restartLocalCoreDaemon,
} from "../src/localCore/daemon.js";
import { resolveLocalCoreStoreClient } from "./localCoreStoreClient.js";
import type { ResolvedModelPolicy } from "../src/profile/modelPolicy.js";
import {
  buildModelCatalogStatusLine,
  buildModelSearchResultBlock,
  buildModelSummaryBlock,
  isSupportedModelSetProvider,
  MODEL_SET_PROVIDER_USAGE,
} from "./modelProviderCommand.js";
import {
  applyKestrelUninstallPlan,
  createKestrelUninstallPlan,
  formatKestrelUninstallPlan,
  readKestrelUninstallPlan,
  writeKestrelUninstallPlan,
} from "../src/uninstall/coordinator.js";
import {
  parseKestrelUninstallScope,
  type KestrelUninstallPlanOptions,
} from "../src/uninstall/contracts.js";

export interface CliCommandServices {
  prepareLocalCore(): Promise<void | CliLocalCoreStatus>;
  requireLocalCore(): Promise<CliLocalCoreStatus>;
}

const DEFAULT_CLI_COMMAND_SERVICES: CliCommandServices = {
  prepareLocalCore: async () => {
    return await ensureCliLocalCoreReady();
  },
  requireLocalCore: ensureCliLocalCoreReady,
};

export async function runCliCommand(
  args: string[],
  cwd = process.cwd(),
  serviceOverrides: Partial<CliCommandServices> = {},
): Promise<void> {
  const services = { ...DEFAULT_CLI_COMMAND_SERVICES, ...serviceOverrides };
  const [command, ...rest] = args;
  if (command === "model") {
    await services.prepareLocalCore();
    await runModelCommand(rest, cwd);
    return;
  }
  if (command === "workspace") {
    await services.prepareLocalCore();
    await runWorkspaceCommand(rest, cwd);
    return;
  }
  if (command === "status") {
    await runStatusCommand(services);
    return;
  }
  if (command === "core") {
    await runCoreCommand(rest);
    return;
  }
  if (command === "web") {
    await runWebCommand(rest, cwd);
    return;
  }
  if (command === "job") {
    const status = await services.prepareLocalCore();
    await runJobCommand(rest, cwd, status?.client);
    return;
  }
  if (command === "operator") {
    const core = await services.requireLocalCore();
    await runOperatorCommand(rest, cwd, core.client);
    return;
  }
  if (command === "setup") {
    await services.prepareLocalCore();
    await runSetupCommand(rest, cwd);
    return;
  }
  if (command === "runtime") {
    const core = await services.requireLocalCore();
    await runRuntimeCommand(rest, cwd, core.client);
    return;
  }
  if (command === "uninstall") {
    await runUninstallCommand(rest);
    return;
  }

  throw new Error(`Unknown command '${command ?? ""}'.`);
}

export function shouldRunCommandMode(args: string[]): boolean {
  const command = args[0];
  return (
    command !== undefined &&
    COMMAND_MODE_COMMANDS.includes(
      command as (typeof COMMAND_MODE_COMMANDS)[number],
    )
  );
}

async function runStatusCommand(services: CliCommandServices): Promise<void> {
  const status = await services.requireLocalCore();
  process.stdout.write(formatCliLocalCoreStatus(status));
}

async function runCoreCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  const options = resolveCliLocalCoreDaemonOptions();
  if (subcommand === "status") {
    if (rest.length > 0) {
      throw new Error("Usage: kestrel core status");
    }
    process.stdout.write(
      formatCliLocalCoreDaemonInspection(await inspectLocalCoreDaemon(options)),
    );
    return;
  }
  if (subcommand === "restart") {
    const waitForIdle = rest.length === 1 && rest[0] === "--wait";
    if (rest.length > 0 && waitForIdle === false) {
      throw new Error("Usage: kestrel core restart [--wait]");
    }
    const before = await inspectLocalCoreDaemon(options);
    const ready = await restartLocalCoreDaemon({ ...options, waitForIdle });
    process.stdout.write(
      `${before.state === "stopped" ? "Started" : "Restarted"} Kestrel Local Core pid=${
        ready.status.lock.state === "live"
          ? ready.status.lock.lock.ownerPid
          : "unknown"
      } build=${(await ready.client?.buildIdentity())?.buildId ?? "unknown"}.\n`,
    );
    return;
  }
  throw new Error("Usage: kestrel core <status|restart> [--wait]");
}

async function runUninstallCommand(args: string[]): Promise<void> {
  const [subcommand = "plan", ...rest] = args;
  if (subcommand !== "plan" && subcommand !== "apply") {
    throw new Error(
      "Usage: kestrel uninstall [plan|apply] --scope current|software|complete",
    );
  }
  if (subcommand === "plan") {
    const options = parseUninstallPlanArgs(rest);
    const plan = await createKestrelUninstallPlan({
      initiator: "cli",
      scope: options.scope,
      options: options.options,
    });
    if (options.out !== undefined) {
      await writeKestrelUninstallPlan(plan, options.out);
    }
    process.stdout.write(
      options.json
        ? `${JSON.stringify(plan, null, 2)}\n`
        : formatKestrelUninstallPlan(plan),
    );
    return;
  }

  const options = parseUninstallApplyArgs(rest);
  const plan = await readKestrelUninstallPlan(options.planPath);
  const result = await applyKestrelUninstallPlan({
    plan,
    confirmPlanId: options.confirmPlanId,
    ...(options.deleteDataPhrase !== undefined
      ? { deleteDataPhrase: options.deleteDataPhrase }
      : {}),
    ...(options.discardWorktreesPhrase !== undefined
      ? { discardWorktreesPhrase: options.discardWorktreesPhrase }
      : {}),
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `Uninstall apply: ${result.status}`,
          `Plan: ${result.planId}`,
          `Removed targets: ${result.removedTargets.length}`,
          `Skipped targets: ${result.skippedTargets.length}`,
          `Kestrel One disconnects: ${result.kestrelOneDisconnects.length}`,
          ...result.kestrelOneDisconnects.map(
            (outcome) =>
              `- ${outcome.connectionId} (${outcome.baseUrl || "unknown URL"}): ${outcome.status}${
                outcome.message ? ` — ${outcome.message}` : ""
              }`,
          ),
          `Deferred completions: ${result.deferredCompletions.length}`,
          ...result.deferredCompletions.map(
            (completion) =>
              `- ${completion.executor}: ${completion.state}; report ${completion.reportPath}`,
          ),
          `Blockers: ${result.blockers.length}`,
          ...result.blockers.map(
            (blocker) => `- ${blocker.code}: ${blocker.message}`,
          ),
          "",
        ].join("\n"),
  );
}

function parseUninstallPlanArgs(args: string[]): {
  scope: ReturnType<typeof parseKestrelUninstallScope>;
  options: KestrelUninstallPlanOptions;
  json: boolean;
  out?: string | undefined;
} {
  let scope: ReturnType<typeof parseKestrelUninstallScope> =
    "current_component";
  const options: KestrelUninstallPlanOptions = {};
  let json = false;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--scope") {
      scope = parseKestrelUninstallScope(requireArgValue(args, index, token));
      index += 1;
      continue;
    }
    if (token === "--disconnect-kestrel-one") {
      options.disconnectKestrelOne = true;
      continue;
    }
    if (token === "--export-worktrees") {
      options.exportWorktreesDirectory = requireArgValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--discard-worktrees") {
      options.discardWorktrees = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--out") {
      out = requireArgValue(args, index, token);
      index += 1;
      continue;
    }
    throw new Error(`Unknown uninstall plan argument '${token ?? ""}'.`);
  }
  return {
    scope,
    options,
    json,
    ...(out !== undefined ? { out } : {}),
  };
}

function parseUninstallApplyArgs(args: string[]): {
  planPath: string;
  confirmPlanId: string;
  deleteDataPhrase?: string | undefined;
  discardWorktreesPhrase?: string | undefined;
  json: boolean;
} {
  let planPath: string | undefined;
  let confirmPlanId: string | undefined;
  let deleteDataPhrase: string | undefined;
  let discardWorktreesPhrase: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--plan") {
      planPath = requireArgValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--confirm") {
      confirmPlanId = requireArgValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--delete-data") {
      deleteDataPhrase = requireArgValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--discard-confirm") {
      discardWorktreesPhrase = requireArgValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown uninstall apply argument '${token ?? ""}'.`);
  }
  if (planPath === undefined || confirmPlanId === undefined) {
    throw new Error(
      "Usage: kestrel uninstall apply --plan <file> --confirm <plan-id>",
    );
  }
  return {
    planPath,
    confirmPlanId,
    ...(deleteDataPhrase !== undefined ? { deleteDataPhrase } : {}),
    ...(discardWorktreesPhrase !== undefined ? { discardWorktreesPhrase } : {}),
    json,
  };
}

function requireArgValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function runWorkspaceCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  const home = resolveKestrelHome(cwd);
  const workspaceStore = new WorkspaceStore(home);

  if (subcommand === "list") {
    const workspaces = await workspaceStore.load();
    const lines = workspaces.workspaces
      .sort((left, right) => left.rootPath.localeCompare(right.rootPath))
      .map((workspace) =>
        [
          workspace.workspaceId,
          workspace.rootPath,
          `automation=${workspace.automationEnabled ? "enabled" : "disabled"}`,
        ].join(" "),
      );
    process.stdout.write(
      lines.length > 0
        ? `${lines.join("\n")}\n`
        : "No workspaces in the catalog.\n",
    );
    return;
  }

  if (subcommand === "status") {
    const resolved = await resolveWorkspaceFromCwd(cwd, workspaceStore);
    if (resolved.workspace === undefined) {
      process.stdout.write("Workspace: none\n");
      return;
    }
    const activeWorkspace = resolved.workspace;
    const workspaces = await workspaceStore.load();
    const entry = workspaceStore.findById(
      workspaces,
      activeWorkspace.manifest.workspaceId,
    );
    process.stdout.write(
      [
        `Workspace: ${activeWorkspace.manifest.workspaceId}`,
        `Root: ${activeWorkspace.rootPath}`,
        ...(activeWorkspace.runtimeContext.launchCwd !== undefined &&
        path.resolve(activeWorkspace.runtimeContext.launchCwd) !==
          path.resolve(activeWorkspace.rootPath)
          ? [`Launch cwd: ${activeWorkspace.runtimeContext.launchCwd}`]
          : []),
        `Automation: ${entry?.automationEnabled === true ? "enabled" : "disabled"}`,
      ].join("\n") + "\n",
    );
    return;
  }

  throw new Error("Usage: kestrel workspace <status|list>");
}

async function runModelCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand = "show", ...rest] = args;
  const home = resolveKestrelHome(cwd);
  const store = new ModelPolicyStore(home);
  const policy = await readCommandModeModelPolicy(home, store);

  if (subcommand === "show") {
    const stageOverrides = Object.entries(policy.modelByStage);
    const catalog = await resolveProviderModelCatalog(policy.provider);
    const summary = buildPresentedProviderModelCatalog({
      provider: policy.provider,
      catalog,
    });
    process.stdout.write(
      [
        `provider: ${policy.provider}`,
        `model: ${policy.model}`,
        `timeoutMs: ${policy.modelTimeoutMs ?? "default"}`,
        `visionInput: ${policy.modelCapabilities.visionInputEnabled ? "enabled" : "disabled"}`,
        `stageOverrides: ${stageOverrides.length > 0 ? stageOverrides.map(([stageId, model]) => `${stageId}=${model}`).join(", ") : "none"}`,
        buildModelCatalogStatusLine(catalog),
        ...(catalog.note !== undefined ? [catalog.note] : []),
        ...buildModelSummaryBlock({
          provider: policy.provider,
          summary,
          selectedModel: policy.model,
          searchCommand: "kestrel model search <query>",
          setCommand: "kestrel model set <exact-model-id>",
        }),
      ].join("\n") + "\n",
    );
    return;
  }

  if (subcommand === "search") {
    const query = rest.join(" ").trim();
    if (query.length === 0) {
      throw new Error("Usage: kestrel model search <query>");
    }
    const catalog = await resolveProviderModelCatalog(policy.provider);
    const result = searchProviderModelCatalog({
      provider: policy.provider,
      catalog,
      query,
    });
    process.stdout.write(
      [
        buildModelCatalogStatusLine(catalog),
        ...(catalog.note !== undefined ? [catalog.note] : []),
        ...buildModelSearchResultBlock(result, {
          searchCommand: "kestrel model search <query>",
          setCommand: "kestrel model set <exact-model-id>",
        }),
      ].join("\n") + "\n",
    );
    return;
  }

  if (subcommand === "set-provider") {
    const provider = rest[0];
    if (isSupportedModelSetProvider(provider) === false) {
      throw new Error(
        `Usage: kestrel model set-provider ${MODEL_SET_PROVIDER_USAGE}`,
      );
    }
    const catalog = await resolveProviderModelCatalog(provider);
    const model = rest.slice(1).join(" ").trim();
    if (model.length === 0) {
      const summary = buildPresentedProviderModelCatalog({ provider, catalog });
      throw new Error(
        [
          `Selecting provider '${provider}' requires an explicit model.`,
          buildModelCatalogStatusLine(catalog),
          ...(catalog.note !== undefined ? [catalog.note] : []),
          ...buildModelSummaryBlock({
            provider,
            summary,
            searchCommand: "kestrel model search <query>",
            setCommand: "kestrel model set <exact-model-id>",
          }),
          `Usage: kestrel model set-provider ${MODEL_SET_PROVIDER_USAGE}`,
        ].join("\n"),
      );
    }
    if (catalog.models.includes(model) === false) {
      throw new Error(
        [
          `Model '${model}' is not allowed for provider '${provider}'.`,
          buildModelCatalogStatusLine(catalog),
          ...(catalog.note !== undefined ? [catalog.note] : []),
          ...buildModelSummaryBlock({
            provider,
            summary: buildPresentedProviderModelCatalog({ provider, catalog }),
            searchCommand: "kestrel model search <query>",
            setCommand: "kestrel model set <exact-model-id>",
          }),
        ].join("\n"),
      );
    }
    const saved = await writeCommandModeModelPolicy(home, store, {
      ...policy,
      provider,
      model,
    });
    process.stdout.write(
      `model provider updated provider=${saved.provider} model=${saved.model}\n`,
    );
    return;
  }

  if (subcommand === "set") {
    const model = rest.join(" ").trim();
    const catalog = await resolveProviderModelCatalog(policy.provider);
    if (model.length === 0) {
      const summary = buildPresentedProviderModelCatalog({
        provider: policy.provider,
        catalog,
      });
      throw new Error(
        [
          "Usage: kestrel model set <model>",
          buildModelCatalogStatusLine(catalog),
          ...(catalog.note !== undefined ? [catalog.note] : []),
          ...buildModelSummaryBlock({
            provider: policy.provider,
            selectedModel: policy.model,
            summary,
            searchCommand: "kestrel model search <query>",
            setCommand: "kestrel model set <exact-model-id>",
          }),
        ].join("\n"),
      );
    }
    if (catalog.models.includes(model) === false) {
      throw new Error(
        [
          `Model '${model}' is not allowed for provider '${policy.provider}'.`,
          buildModelCatalogStatusLine(catalog),
          ...(catalog.note !== undefined ? [catalog.note] : []),
          ...buildModelSummaryBlock({
            provider: policy.provider,
            summary: buildPresentedProviderModelCatalog({
              provider: policy.provider,
              catalog,
            }),
            selectedModel: policy.model,
            searchCommand: "kestrel model search <query>",
            setCommand: "kestrel model set <exact-model-id>",
          }),
        ].join("\n"),
      );
    }
    const saved = await writeCommandModeModelPolicy(home, store, {
      ...policy,
      model,
    });
    process.stdout.write(
      `model updated provider=${saved.provider} model=${saved.model}\n`,
    );
    return;
  }

  throw new Error("Usage: kestrel model <show|search|set-provider|set> ...");
}

async function readCommandModeModelPolicy(
  home: string,
  store: ModelPolicyStore,
): Promise<ResolvedModelPolicy> {
  const core = resolveLocalCoreStoreClient(home);
  if (core !== undefined) {
    const response = (await core.client.getJson("/v1/settings")) as {
      settings?: { modelPolicy?: unknown } | undefined;
    };
    if (response.settings?.modelPolicy !== undefined) {
      return response.settings.modelPolicy as ResolvedModelPolicy;
    }
  }
  return store.read();
}

async function writeCommandModeModelPolicy(
  home: string,
  store: ModelPolicyStore,
  policy: ResolvedModelPolicy,
): Promise<ResolvedModelPolicy> {
  const core = resolveLocalCoreStoreClient(home);
  if (core !== undefined) {
    const response = (await core.client.patchJson("/v1/settings", {
      modelPolicy: policy,
    })) as {
      settings?: { modelPolicy?: unknown } | undefined;
    };
    if (response.settings?.modelPolicy !== undefined) {
      return response.settings.modelPolicy as ResolvedModelPolicy;
    }
  }
  return store.write(policy);
}

async function runJobCommand(
  args: string[],
  cwd: string,
  localCoreClient?: LocalCoreClient | undefined,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "run" && subcommand !== "preflight") {
    throw new Error(
      "Usage: kestrel job <preflight|run> --json-in <file> --json-out <file> [--profile <id>]",
    );
  }
  rejectClientOwnedStoreSelection(rest, `kestrel job ${subcommand}`);
  const jsonIn = readRequiredFlag(rest, "--json-in");
  const jsonOut = readRequiredFlag(rest, "--json-out");
  const profileIdFlag = readFlag(rest, "--profile");

  const rawInput = await readFile(resolveFromCwd(cwd, jsonIn), "utf8");
  const parsedInput = parseJobInput(JSON.parse(rawInput));
  if (subcommand === "preflight") {
    if (parsedInput.version !== "job_input_v2") {
      throw new Error("kestrel job preflight requires job_input_v2");
    }
    if (profileIdFlag !== undefined) {
      throw new Error("kestrel job preflight does not accept --profile; use job_input_v2.profileId");
    }
    const { output } = await resolveJobPreflight(cwd, parsedInput, localCoreClient);
    await writeJson(resolveFromCwd(cwd, jsonOut), output);
    if (output.status === "setup_required") {
      throw new Error(`SETUP_REQUIRED: ${output.remediation ?? "Required tools are unavailable."}`);
    }
    process.stdout.write(`job preflight ready profile=${output.profileId}\n`);
    return;
  }
  if (parsedInput.version === "job_input_v2") {
    if (profileIdFlag !== undefined) {
      throw new Error("kestrel job run does not accept --profile with job_input_v2");
    }
    await runBoundJobV2(cwd, jsonOut, parsedInput, localCoreClient);
    return;
  }
  const input = parsedInput;
  const settings = await readRuntimeSettings(resolveKestrelHome(cwd));
  if (input.storeDriver !== undefined) {
    throw new Error(
      "job input storeDriver is no longer supported; Local Core owns persistence for every local run.",
    );
  }
  if (input.profile !== undefined) {
    throw new Error(
      "job input inline profiles are not supported by Local Core; persist the custom profile and reference its profileId.",
    );
  }
  const home = resolveKestrelHome(cwd);
  const profileStore = new ProfileStore(home);
  const profiles = await profileStore.load();
  const profile = resolveJobProfile({
    profileStore,
    profiles,
    explicitProfileId: profileIdFlag,
    settingsProfileId: settings.defaults.profileId,
    inputProfileId: input.profileId,
    inputProfile: input.profile,
  });
  const effectiveProfile: TuiProfile = {
    ...toCoreExecutionProfile(profile),
    ...(settings.defaults.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: settings.defaults.approvalPolicyPackId }
      : {}),
    ...(input.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: input.approvalPolicyPackId }
      : {}),
  };

  const client = createConfiguredCliProtocolClient();
  const core = requireLocalCoreClient(cwd, localCoreClient);
  const executionProfile = await core.resolveExecutionProfile({
    client: "cli",
    profileId: profile.id,
  });
  const eventLogPath = process.env.KESTREL_JOB_EVENT_LOG_PATH?.trim();
  const unsubscribe =
    eventLogPath !== undefined && eventLogPath.length > 0
      ? client.onEvent((event) => {
          appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
        })
      : undefined;
  try {
    if (eventLogPath !== undefined && eventLogPath.length > 0) {
      await mkdir(path.dirname(eventLogPath), { recursive: true });
    }
    const commandId = randomUUID();
    const commandPayload = buildResolvedJobRunCommandPayload(
      {
        ...input,
        approvalPolicyPackId:
          input.approvalPolicyPackId ?? settings.defaults.approvalPolicyPackId,
      },
      effectiveProfile,
      executionProfile.profileId,
    );
    const response = await client.sendCommandWithId(
      commandId,
      "job.run",
      commandPayload,
    );
    if (response.type !== "job.completed" && response.type !== "job.failed") {
      throw new Error(`Unexpected job response '${response.type}'.`);
    }
    const output: JobOutputV1 = {
      version: "job_output_v1",
      terminalEventType: response.type,
      job: response.payload.output,
    };
    await writeJson(resolveFromCwd(cwd, jsonOut), output);
    process.stdout.write(
      `job ${response.type === "job.completed" ? "completed" : "failed"} session=${output.job.sessionId} thread=${output.job.threadId} run=${output.job.runId}\n`,
    );
    if (response.type === "job.failed") {
      throw new Error(
        `${response.payload.error.code}: ${response.payload.error.message}`,
      );
    }
  } finally {
    unsubscribe?.();
    await client.close();
  }
}

async function resolveJobPreflight(
  cwd: string,
  input: JobInputV2,
  localCoreClient?: LocalCoreClient | undefined,
): Promise<{ output: JobPreflightV1; resolvedProfile: TuiProfile }> {
  const core = requireLocalCoreClient(cwd, localCoreClient);
  const resolution = await core.resolveExecutionProfile({
    client: "cli",
    profileId: input.profileId,
    environmentPresetId: input.environmentPresetId,
  });
  if (
    resolution.environmentPreset.id !== "cli_safe_local"
    && resolution.environmentPreset.id !== "cli_dev_local"
  ) {
    throw new Error(
      `COMPATIBILITY_ERROR: Local Core resolved unsupported preset '${resolution.environmentPreset.id}'.`,
    );
  }
  const pack = getApprovalPolicyPack(input.approvalPolicyPackId);
  const effectiveTools = sortedUnique(resolution.resolvedProfile.toolAllowlist ?? []);
  const requiredTools = sortedUnique(input.requiredTools);
  const missingTools = requiredTools.filter((tool) => !effectiveTools.includes(tool));
  const policyRevision =
    `${resolution.policy.id}:v${resolution.policy.version}`
    + `/${resolution.environmentPreset.id}:v${resolution.environmentPreset.version}`;
  const executionProfileBinding: JobExecutionProfileBindingV1 = {
    version: "job_execution_profile_binding_v1",
    authoringProfileId: input.profileId,
    environmentPresetId: resolution.environmentPreset.id,
    resolvedProfileId: resolution.profileId,
    profileFingerprint: resolution.fingerprint,
    policy: { ...resolution.policy },
    approvalPolicyPack: {
      id: pack.id,
      version: pack.version,
      digest: digestApprovalPolicyPack(pack),
    },
  };
  const output: JobPreflightV1 = {
    version: "job_preflight_v1",
    capability: "local-core.execution-profile-resolution.v2",
    status: missingTools.length === 0 ? "ready" : "setup_required",
    requestedPresetId: input.environmentPresetId,
    resolvedPresetId: resolution.environmentPreset.id,
    profileId: resolution.profileId,
    profileFingerprint: resolution.fingerprint,
    policyRevision,
    approvalPolicyPackId: pack.id,
    effectiveTools,
    requiredTools,
    missingTools,
    executionProfileBinding,
    ...(missingTools.length > 0
      ? {
          code: "SETUP_REQUIRED" as const,
          remediation: `Enable the required tool(s) in the resolved profile: ${missingTools.join(", ")}.`,
        }
      : {}),
  };
  return { output, resolvedProfile: resolution.resolvedProfile };
}

async function runBoundJobV2(
  cwd: string,
  jsonOut: string,
  input: JobInputV2,
  localCoreClient?: LocalCoreClient | undefined,
): Promise<void> {
  const binding = input.executionProfileBinding;
  if (binding === undefined) {
    return await rejectBoundJob(cwd, jsonOut, ["executionProfileBinding is required for job run"]);
  }
  let evidence: Awaited<ReturnType<typeof resolveJobPreflight>>;
  try {
    evidence = await resolveJobPreflight(cwd, input, localCoreClient);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return await rejectBoundJob(cwd, jsonOut, [
      `current preflight failed: ${message}`,
    ]);
  }
  const preflight = evidence.output;
  const mismatches = compareJobBinding(binding, preflight);
  if (preflight.missingTools.length > 0) {
    mismatches.push(`required tools are unavailable: ${preflight.missingTools.join(", ")}`);
  }
  if (mismatches.length > 0) {
    return await rejectBoundJob(cwd, jsonOut, mismatches);
  }

  const effectiveProfile: TuiProfile = {
    ...evidence.resolvedProfile,
    approvalPolicyPackId: input.approvalPolicyPackId,
  };
  const client = createConfiguredCliProtocolClient();
  const eventLogPath = process.env.KESTREL_JOB_EVENT_LOG_PATH?.trim();
  const unsubscribe =
    eventLogPath !== undefined && eventLogPath.length > 0
      ? client.onEvent((event) => {
          appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
        })
      : undefined;
  try {
    if (eventLogPath !== undefined && eventLogPath.length > 0) {
      await mkdir(path.dirname(eventLogPath), { recursive: true });
    }
    const commandPayload = buildResolvedJobRunCommandPayload(
      {
        version: "job_input_v1",
        turn: input.turn,
        approvalPolicyPackId: input.approvalPolicyPackId,
      },
      effectiveProfile,
      binding.resolvedProfileId,
    );
    const response = await client.sendCommandWithId(
      randomUUID(),
      "job.run",
      commandPayload,
    );
    if (response.type !== "job.completed" && response.type !== "job.failed") {
      throw new Error(`Unexpected job response '${response.type}'.`);
    }
    const output: JobOutputV1 = {
      version: "job_output_v1",
      terminalEventType: response.type,
      job: response.payload.output,
    };
    await writeJson(resolveFromCwd(cwd, jsonOut), output);
    process.stdout.write(
      `job ${response.type === "job.completed" ? "completed" : "failed"} session=${output.job.sessionId} thread=${output.job.threadId} run=${output.job.runId}\n`,
    );
    if (response.type === "job.failed") {
      throw new Error(`${response.payload.error.code}: ${response.payload.error.message}`);
    }
  } finally {
    unsubscribe?.();
    await client.close();
  }
}

export function compareJobBinding(
  binding: JobExecutionProfileBindingV1,
  preflight: JobPreflightV1,
): string[] {
  const expected = preflight.executionProfileBinding;
  const mismatches: string[] = [];
  const compare = (label: string, actual: unknown, wanted: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      mismatches.push(`${label} does not match current preflight evidence`);
    }
  };
  compare("authoring profile", binding.authoringProfileId, expected.authoringProfileId);
  compare("environment preset", binding.environmentPresetId, expected.environmentPresetId);
  compare("resolved profile", binding.resolvedProfileId, expected.resolvedProfileId);
  compare("profile fingerprint", binding.profileFingerprint, expected.profileFingerprint);
  compare("policy", binding.policy, expected.policy);
  compare("approval policy pack", binding.approvalPolicyPack, expected.approvalPolicyPack);
  return mismatches;
}

async function rejectBoundJob(
  cwd: string,
  jsonOut: string,
  mismatches: string[],
): Promise<never> {
  const output: JobRunRejectionV1 = {
    version: "job_run_rejection_v1",
    code: "COMPATIBILITY_ERROR",
    message: "The execution profile binding is missing, stale, or has been altered.",
    details: { mismatches: sortedUnique(mismatches) },
  };
  await writeJson(resolveFromCwd(cwd, jsonOut), output);
  throw new Error(`COMPATIBILITY_ERROR: ${output.message}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildResolvedJobRunCommandPayload(
  input: JobInputV1,
  effectiveProfile: TuiProfile,
  registeredProfileId: string,
): JobRunCommandPayload {
  if (input.storeDriver !== undefined) {
    throw new Error(
      "job input storeDriver is no longer supported; Local Core owns persistence for every local run.",
    );
  }
  return {
    profileId: registeredProfileId,
    input: {
      version: input.version,
      turn: {
        ...input.turn,
        eventType: input.turn.eventType ?? "job.run",
        stepAgent:
          input.turn.stepAgent ?? resolveJobEntryStepAgent(effectiveProfile),
      },
      ...(input.approvalPolicyPackId !== undefined
        ? { approvalPolicyPackId: input.approvalPolicyPackId }
        : {}),
    },
  };
}

function resolveJobEntryStepAgent(profile: Pick<TuiProfile, "agent">): string {
  if (profile.agent === "kestrel") {
    return AGENT_STEP_IDS.loop;
  }
  throw new Error(`Unsupported profile agent '${profile.agent}'`);
}

async function runOperatorCommand(
  args: string[],
  cwd: string,
  localCoreClient?: LocalCoreClient | undefined,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "resume-wait") {
    const threadId = readRequiredFlag(rest, "--thread-id");
    const reason = readFlag(rest, "--reason");
    const result = await sendOperatorControl({
      action: "retry",
      threadId,
      ...(reason !== undefined ? { message: reason } : {}),
    });
    process.stdout.write(`resume-wait dispatched thread=${threadId}\n`);
    printOperatorTerminalResult(result);
    return;
  }
  if (subcommand === "approve") {
    const threadId = readRequiredFlag(rest, "--thread-id");
    const requestId = readRequiredFlag(rest, "--request-id");
    const result = await sendOperatorControl({
      action: "approve",
      threadId,
      requestId,
    });
    process.stdout.write(
      `approve dispatched thread=${threadId} request=${requestId}\n`,
    );
    printOperatorTerminalResult(result);
    return;
  }
  if (subcommand === "retry-delegation") {
    const threadId = readRequiredFlag(rest, "--thread-id");
    const delegationId = readRequiredFlag(rest, "--delegation-id");
    const result = await sendOperatorControl({
      action: "supersede_child_thread",
      threadId,
      delegationId,
      message: "Retry delegation requested via operator quick path.",
    });
    process.stdout.write(
      `retry-delegation dispatched thread=${threadId} delegation=${delegationId}\n`,
    );
    printOperatorTerminalResult(result);
    return;
  }
  if (subcommand === "doctor-export") {
    const runId = readRequiredFlag(rest, "--run-id");
    const outPath = readRequiredFlag(rest, "--out");
    rejectClientOwnedStoreSelection(rest, "kestrel operator doctor-export");
    const report = await requireLocalCoreClient(
      cwd,
      localCoreClient,
    ).runtimeDoctor({ runId });
    await writeJson(resolveFromCwd(cwd, outPath), report);
    process.stdout.write(
      `doctor report exported: ${outPath} status=${report.status}\n`,
    );
    return;
  }
  throw new Error(
    "Usage: kestrel operator <resume-wait|approve|retry-delegation|doctor-export> ...",
  );
}

async function runSetupCommand(args: string[], cwd: string): Promise<void> {
  if (
    hasFlagOrAssignment(args, "--store") ||
    hasFlagOrAssignment(args, "--sqlite-path")
  ) {
    throw new Error(
      "kestrel setup no longer accepts --store or --sqlite-path; Local Core owns database configuration.",
    );
  }
  const home = resolveKestrelHome(cwd);
  const profileStore = new ProfileStore(home);
  const profiles = await profileStore.load();
  const defaultProfile = profileStore.getDefault(profiles);
  const explicitProfileId = readFlag(args, "--profile");
  const selectedProfile =
    explicitProfileId !== undefined
      ? profileStore.findById(profiles, explicitProfileId)
      : defaultProfile;
  if (selectedProfile === undefined) {
    throw new Error(`Profile '${explicitProfileId}' not found.`);
  }
  const approvalPolicyPackId =
    readOptionalApprovalPack(readFlag(args, "--approval-pack")) ?? "dev";
  const minimalMode = args.includes("--full") ? false : true;
  const nextSettings: RuntimeSettingsFile = {
    version: 1,
    defaults: {
      profileId: selectedProfile.id,
      approvalPolicyPackId,
      minimalMode,
    },
  };
  await writeRuntimeSettings(home, nextSettings);
  process.stdout.write(
    [
      "kestrel setup complete",
      `home: ${home}`,
      `profile: ${selectedProfile.id}`,
      "database: Local Core (PGlite by default)",
      `approval-pack: ${approvalPolicyPackId}`,
      `minimal-mode: ${minimalMode ? "on" : "off"}`,
      "next: run `kestrel job run --json-in <file> --json-out <file>` or `kestrel`",
    ].join("\n") + "\n",
  );
}

async function runRuntimeCommand(
  args: string[],
  cwd: string,
  localCoreClient?: LocalCoreClient | undefined,
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (
    subcommand !== "replay" &&
    subcommand !== "doctor" &&
    subcommand !== "bundle"
  ) {
    throw new Error(
      "Usage: kestrel runtime <replay|doctor> <query> [--json]; kestrel runtime bundle <query> --out <file>",
    );
  }
  rejectClientOwnedStoreSelection(rest, `kestrel runtime ${subcommand}`);
  const query = readReplayQueryFlags(rest);
  const client = requireLocalCoreClient(cwd, localCoreClient);
  if (subcommand === "replay") {
    const replay = await client.runtimeReplay(query);
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    } else {
      for (const line of formatReplayInspection(replay)) {
        process.stdout.write(`${line}\n`);
      }
    }
    return;
  }
  if (subcommand === "doctor") {
    const report = await client.runtimeDoctor(query);
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const line of formatDoctorInspection(report)) {
        process.stdout.write(`${line}\n`);
      }
    }
    return;
  }

  const outPath = readRequiredFlag(rest, "--out");
  const bundle = await client.runtimeBundle(query);
  await writeJson(resolveFromCwd(cwd, outPath), bundle);
  process.stdout.write(
    `runtime bundle exported: ${outPath} run=${bundle.focus.runId ?? "n/a"} thread=${bundle.focus.threadId ?? "n/a"}\n`,
  );
}

async function sendOperatorControl(
  payload: OperatorControlCommandPayload,
): Promise<OperatorControlledEventPayload> {
  const client = createConfiguredCliProtocolClient();
  try {
    const response = await client.sendCommand("operator.control", payload);
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator response '${response.type}'.`);
    }
    return response.payload;
  } finally {
    await client.close();
  }
}

function printOperatorTerminalResult(
  payload: OperatorControlledEventPayload,
): void {
  const result = payload.result;
  if (result === undefined) return;
  if (result.output.status === "WAITING") {
    const prompt = extractWaitPrompt(result.output.waitFor);
    if (prompt !== undefined) process.stdout.write(`${prompt}\n`);
    return;
  }
  if (result.assistantText !== null) {
    process.stdout.write(`${result.assistantText}\n`);
  }
}

function resolveJobProfile(input: {
  profileStore: ProfileStore;
  profiles: TuiProfile[];
  explicitProfileId?: string | undefined;
  settingsProfileId?: string | undefined;
  inputProfileId?: string | undefined;
  inputProfile?: TuiProfile | undefined;
}): TuiProfile {
  if (input.inputProfile !== undefined) {
    return input.inputProfile;
  }
  const profileId =
    input.explicitProfileId ?? input.inputProfileId ?? input.settingsProfileId;
  if (profileId !== undefined) {
    const found = input.profileStore.findById(input.profiles, profileId);
    if (found === undefined) {
      throw new Error(`Profile '${profileId}' was not found.`);
    }
    return found;
  }
  return input.profileStore.getDefault(input.profiles);
}

function readReplayQueryFlags(args: string[]): ReplayQuery {
  const runId = readFlag(args, "--run-id");
  const sessionId = readFlag(args, "--session-id");
  const threadId = readFlag(args, "--thread-id");
  const delegationId = readFlag(args, "--delegation-id");
  const eventTypes = readMultiFlag(args, "--event-type");
  const limit = readOptionalInteger(readFlag(args, "--limit"));
  if (
    runId === undefined &&
    sessionId === undefined &&
    threadId === undefined &&
    delegationId === undefined
  ) {
    throw new Error(
      "Expected --run-id <id>, --session-id <id>, --thread-id <id>, or --delegation-id <id>",
    );
  }
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(delegationId !== undefined ? { delegationId } : {}),
    ...(eventTypes.length > 0
      ? { eventTypes: eventTypes as ReplayQuery["eventTypes"] }
      : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function requireLocalCoreClient(
  cwd: string,
  localCoreClient?: LocalCoreClient | undefined,
): LocalCoreClient {
  if (localCoreClient !== undefined) {
    return localCoreClient;
  }
  const resolved = resolveLocalCoreStoreClient(resolveKestrelHome(cwd));
  if (resolved === undefined) {
    throw new Error("This command requires the authenticated Local Core API.");
  }
  return resolved.client;
}

function rejectClientOwnedStoreSelection(
  args: string[],
  command: string,
): void {
  if (hasFlagOrAssignment(args, "--store")) {
    throw new Error(
      `${command} no longer accepts --store; Local Core owns persistence selection.`,
    );
  }
}

function hasFlagOrAssignment(args: string[], flag: string): boolean {
  return args.some((value) => value === flag || value.startsWith(`${flag}=`));
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readRequiredFlag(args: string[], name: string): string {
  const value = readFlag(args, name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readMultiFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}

function readOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    throw new Error("Expected a positive integer.");
  }
  return parsed;
}

function readOptionalApprovalPack(
  value: string | undefined,
): "dev" | "ci_bot" | "production" | undefined {
  if (value === undefined) {
    return;
  }
  if (value === "dev" || value === "ci_bot" || value === "production") {
    return value;
  }
  throw new Error(
    `Unsupported approval pack '${value}'. Expected dev|ci_bot|production.`,
  );
}

async function writeJson(targetPath: string, payload: unknown): Promise<void> {
  const absolute = path.resolve(targetPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function resolveFromCwd(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}
