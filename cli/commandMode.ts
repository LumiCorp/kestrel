import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildPresentedProviderModelCatalog,
  ModelPolicyStore,
  resolveProviderModelCatalog,
  searchProviderModelCatalog,
  type ToolExecutionClass,
} from "../src/index.js";
import { createSessionStoreFromEnv } from "../src/store/createSessionStore.js";
import type { TuiProfile } from "./contracts.js";
import { InProcessRunnerTransport } from "./client/InProcessRunnerTransport.js";
import { ProtocolClient } from "./client/ProtocolClient.js";
import type { ProtocolTransport } from "./client/ProtocolClient.js";
import { RunnerProcess } from "./client/RunnerProcess.js";
import { COMMAND_MODE_COMMANDS } from "./contractMatrix.js";
import { ProfileStore } from "./config/ProfileStore.js";
import { readRuntimeSettings, writeRuntimeSettings, type RuntimeSettingsFile } from "./config/RuntimeSettings.js";
import { resolveKestrelHome } from "./config/kestrelHome.js";
import type { JobOutputV1 } from "./job/contracts.js";
import { parseJobInputV1 } from "./job/contracts.js";
import { buildJobReplayPointer } from "./job/contracts.js";
import type { OperatorControlCommandPayload, RunnerEvent } from "./protocol/contracts.js";
import { writeDoctorReport, writeRuntimeReplayBundle } from "./runtime/replayBundle.js";
import { runWebCommand } from "./webCommand.js";
import { WorkspaceStore } from "./workspace/WorkspaceStore.js";
import { resolveWorkspaceFromCwd } from "./workspace/WorkspaceResolver.js";
import { ensureCliLocalCoreReady, formatCliLocalCoreStatus } from "./localCoreShell.js";
import { resolveLocalCoreStoreClient } from "./localCoreStoreClient.js";
import type { ResolvedModelPolicy } from "../src/profile/modelPolicy.js";
import {
  buildModelCatalogStatusLine,
  buildModelSearchResultBlock,
  buildModelSummaryBlock,
  isSupportedModelSetProvider,
  MODEL_SET_PROVIDER_USAGE,
} from "./modelProviderCommand.js";

export async function runCliCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const [command, ...rest] = args;
  if (command === "model") {
    await ensureCliLocalCoreReady();
    await runModelCommand(rest, cwd);
    return;
  }
  if (command === "workspace") {
    await ensureCliLocalCoreReady();
    await runWorkspaceCommand(rest, cwd);
    return;
  }
  if (command === "status") {
    await runStatusCommand();
    return;
  }
  if (command === "web") {
    await ensureCliLocalCoreReady();
    await runWebCommand(rest, cwd);
    return;
  }
  if (command === "job") {
    await ensureCliLocalCoreReady();
    await runJobCommand(rest, cwd);
    return;
  }
  if (command === "operator") {
    await ensureCliLocalCoreReady();
    await runOperatorCommand(rest, cwd);
    return;
  }
  if (command === "setup") {
    await ensureCliLocalCoreReady();
    await runSetupCommand(rest, cwd);
    return;
  }
  if (command === "runtime") {
    await ensureCliLocalCoreReady();
    await runRuntimeCommand(rest, cwd);
    return;
  }

  throw new Error(`Unknown command '${command ?? ""}'.`);
}

export function shouldRunCommandMode(args: string[]): boolean {
  const command = args[0];
  return command !== undefined && COMMAND_MODE_COMMANDS.includes(command as (typeof COMMAND_MODE_COMMANDS)[number]);
}

async function runStatusCommand(): Promise<void> {
  const status = await ensureCliLocalCoreReady();
  process.stdout.write(formatCliLocalCoreStatus(status));
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
    process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "No workspaces in the catalog.\n");
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
    const entry = workspaceStore.findById(workspaces, activeWorkspace.manifest.workspaceId);
    process.stdout.write(
      [
        `Workspace: ${activeWorkspace.manifest.workspaceId}`,
        `Root: ${activeWorkspace.rootPath}`,
        ...(activeWorkspace.runtimeContext.launchCwd !== undefined &&
        path.resolve(activeWorkspace.runtimeContext.launchCwd) !== path.resolve(activeWorkspace.rootPath)
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
      throw new Error(`Usage: kestrel model set-provider ${MODEL_SET_PROVIDER_USAGE}`);
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
    process.stdout.write(`model provider updated provider=${saved.provider} model=${saved.model}\n`);
    return;
  }

  if (subcommand === "set") {
    const model = rest.join(" ").trim();
    const catalog = await resolveProviderModelCatalog(policy.provider);
    if (model.length === 0) {
      const summary = buildPresentedProviderModelCatalog({ provider: policy.provider, catalog });
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
            summary: buildPresentedProviderModelCatalog({ provider: policy.provider, catalog }),
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
    process.stdout.write(`model updated provider=${saved.provider} model=${saved.model}\n`);
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
    const response = await core.client.getJson("/v1/settings") as {
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
    const response = await core.client.patchJson("/v1/settings", { modelPolicy: policy }) as {
      settings?: { modelPolicy?: unknown } | undefined;
    };
    if (response.settings?.modelPolicy !== undefined) {
      return response.settings.modelPolicy as ResolvedModelPolicy;
    }
  }
  return store.write(policy);
}

async function runJobCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "run") {
    throw new Error("Usage: kestrel job run --json-in <file> --json-out <file> [--profile <id>] [--store auto|postgres|sqlite]");
  }
  const jsonIn = readRequiredFlag(rest, "--json-in");
  const jsonOut = readRequiredFlag(rest, "--json-out");
  const profileIdFlag = readFlag(rest, "--profile");
  const storeDriver = readOptionalStoreDriver(readFlag(rest, "--store"));

  const settings = await readRuntimeSettings(resolveKestrelHome(cwd));
  const rawInput = await readFile(resolveFromCwd(cwd, jsonIn), "utf8");
  const input = parseJobInputV1(JSON.parse(rawInput));
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
    ...profile,
    ...(settings.defaults.storeDriver !== undefined ? { storeDriver: settings.defaults.storeDriver } : {}),
    ...(storeDriver !== undefined ? { storeDriver } : {}),
    ...(input.storeDriver !== undefined ? { storeDriver: input.storeDriver } : {}),
    ...(settings.defaults.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: settings.defaults.approvalPolicyPackId }
      : {}),
    ...(input.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: input.approvalPolicyPackId }
      : {}),
  };

  const client = new ProtocolClient(createCommandModeTransport(cwd));
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
    let resolveRunCompleted:
      | ((event: Extract<RunnerEvent, { type: "run.progress" }>) => void)
      | undefined;
    const runCompleted = new Promise<Extract<RunnerEvent, { type: "run.progress" }>>((resolve) => {
      resolveRunCompleted = resolve;
    });
    const unsubscribeRunCompleted = client.onEvent((event) => {
      if (
        event.commandId === commandId &&
        event.type === "run.progress" &&
        event.payload.update.code === "RUN_COMPLETED"
      ) {
        resolveRunCompleted?.(event);
      }
    });
    const commandPayload = {
      profile: effectiveProfile,
      input: {
        ...input,
        turn: {
          ...input.turn,
          eventType: input.turn.eventType ?? "job.run",
        },
      },
    };
    const response = await Promise.race([
      client.sendCommandWithId(commandId, "job.run", commandPayload),
      runCompleted,
    ]);
    unsubscribeRunCompleted();
    if (response.type === "run.progress") {
      const threadId = response.threadId ?? response.sessionId ?? input.turn.sessionId;
      const runId = response.runId ?? response.payload.update.runId;
      const replay = buildJobReplayPointer({
        sessionId: input.turn.sessionId,
        threadId,
        runId,
      });
      const output: JobOutputV1 = {
        version: "job_output_v1",
        terminalEventType: "job.completed",
        job: {
          version: "job_run_result_v1",
          sessionId: input.turn.sessionId,
          threadId,
          runId,
          status: "COMPLETED",
          replay,
        },
      };
      await writeJson(resolveFromCwd(cwd, jsonOut), output);
      process.stdout.write(
        `job completed session=${output.job.sessionId} thread=${output.job.threadId} run=${output.job.runId}\n`,
      );
      return;
    }
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

async function runOperatorCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "resume-wait") {
    const threadId = readRequiredFlag(rest, "--thread-id");
    const reason = readFlag(rest, "--reason");
    await sendOperatorControl(cwd, {
      action: "retry",
      threadId,
      ...(reason !== undefined ? { message: reason } : {}),
    });
    process.stdout.write(`resume-wait dispatched thread=${threadId}\n`);
    return;
  }
  if (subcommand === "approve") {
    const threadId = readRequiredFlag(rest, "--thread-id");
    const requestId = readRequiredFlag(rest, "--request-id");
    const allowToolClasses = parseToolClasses(readMultiFlag(rest, "--allow-tool-class"));
    const allowCapabilities = readMultiFlag(rest, "--allow-capability");
    await sendOperatorControl(cwd, {
      action: "approve",
      threadId,
      requestId,
      ...(allowToolClasses.length > 0 ? { allowToolClasses } : {}),
      ...(allowCapabilities.length > 0 ? { allowCapabilities } : {}),
    });
    process.stdout.write(
      `approve dispatched thread=${threadId} request=${requestId} toolClasses=${allowToolClasses.length} capabilities=${allowCapabilities.length}\n`,
    );
    return;
  }
  if (subcommand === "retry-delegation") {
    const threadId = readRequiredFlag(rest, "--thread-id");
    const delegationId = readRequiredFlag(rest, "--delegation-id");
    await sendOperatorControl(cwd, {
      action: "supersede_child_thread",
      threadId,
      delegationId,
      message: "Retry delegation requested via operator quick path.",
    });
    process.stdout.write(`retry-delegation dispatched thread=${threadId} delegation=${delegationId}\n`);
    return;
  }
  if (subcommand === "doctor-export") {
    const runId = readRequiredFlag(rest, "--run-id");
    const outPath = readRequiredFlag(rest, "--out");
    const storeDriver = readOptionalStoreDriver(readFlag(rest, "--store"));
    const handle = createSessionStoreFromEnv({
      ...(storeDriver !== undefined ? { driver: storeDriver } : {}),
    });
    try {
      const report = await writeDoctorReport(handle.store, { runId }, resolveFromCwd(cwd, outPath));
      process.stdout.write(`doctor report exported: ${outPath} status=${report.status}\n`);
    } finally {
      await handle.close();
    }
    return;
  }
  throw new Error(
    "Usage: kestrel operator <resume-wait|approve|retry-delegation|doctor-export> ...",
  );
}

async function runSetupCommand(args: string[], cwd: string): Promise<void> {
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
  const storeDriver = readOptionalStoreDriver(readFlag(args, "--store")) ?? "auto";
  const sqlitePath = readFlag(args, "--sqlite-path");
  const approvalPolicyPackId = readOptionalApprovalPack(readFlag(args, "--approval-pack")) ?? "dev";
  const minimalMode = args.includes("--full") ? false : true;
  const nextSettings: RuntimeSettingsFile = {
    version: 1,
    defaults: {
      profileId: selectedProfile.id,
      storeDriver,
      ...(sqlitePath !== undefined ? { sqlitePath } : {}),
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
      `store: ${storeDriver}`,
      `approval-pack: ${approvalPolicyPackId}`,
      `minimal-mode: ${minimalMode ? "on" : "off"}`,
      "next: run `kestrel job run --json-in <file> --json-out <file>` or `kestrel`",
    ].join("\n") + "\n",
  );
}

async function runRuntimeCommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "bundle") {
    throw new Error("Usage: kestrel runtime bundle --run-id|--thread-id <id> --out <file> [--store auto|postgres|sqlite]");
  }
  const outPath = readRequiredFlag(rest, "--out");
  const storeDriver = readOptionalStoreDriver(readFlag(rest, "--store"));
  const query = readReplayQueryFlags(rest);
  const handle = createSessionStoreFromEnv({
    ...(storeDriver !== undefined ? { driver: storeDriver } : {}),
  });
  try {
    const bundle = await writeRuntimeReplayBundle(handle.store, query, resolveFromCwd(cwd, outPath));
    process.stdout.write(
      `runtime bundle exported: ${outPath} run=${bundle.focus.runId ?? "n/a"} thread=${bundle.focus.threadId ?? "n/a"}\n`,
    );
  } finally {
    await handle.close();
  }
}

async function sendOperatorControl(
  cwd: string,
  payload: OperatorControlCommandPayload,
): Promise<void> {
  const client = new ProtocolClient(createCommandModeTransport(cwd));
  try {
    const response = await client.sendCommand("operator.control", payload);
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator response '${response.type}'.`);
    }
  } finally {
    await client.close();
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
  const profileId = input.explicitProfileId ?? input.inputProfileId ?? input.settingsProfileId;
  if (profileId !== undefined) {
    const found = input.profileStore.findById(input.profiles, profileId);
    if (found === undefined) {
      throw new Error(`Profile '${profileId}' was not found.`);
    }
    return found;
  }
  return input.profileStore.getDefault(input.profiles);
}

function createCommandModeTransport(cwd: string): ProtocolTransport {
  return resolveCommandModeRunnerMode(process.env) === "inprocess"
    ? new InProcessRunnerTransport()
    : new RunnerProcess({ cwd });
}

export function resolveCommandModeRunnerModeForTests(env: NodeJS.ProcessEnv): "child" | "inprocess" {
  return resolveCommandModeRunnerMode(env);
}

function resolveCommandModeRunnerMode(env: NodeJS.ProcessEnv): "child" | "inprocess" {
  const raw = env.KESTREL_RUNNER_PROCESS_MODE ?? env.KCHAT_RUNNER_MODE;
  const normalized = raw?.trim().toLowerCase();
  return normalized === "inprocess" || normalized === "in_process" ? "inprocess" : "child";
}

function readReplayQueryFlags(args: string[]): {
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  delegationId?: string | undefined;
  limit?: number | undefined;
} {
  const runId = readFlag(args, "--run-id");
  const sessionId = readFlag(args, "--session-id");
  const threadId = readFlag(args, "--thread-id");
  const delegationId = readFlag(args, "--delegation-id");
  const limit = readOptionalInteger(readFlag(args, "--limit"));
  if (runId === undefined && sessionId === undefined && threadId === undefined && delegationId === undefined) {
    throw new Error("Expected --run-id <id>, --session-id <id>, --thread-id <id>, or --delegation-id <id>");
  }
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(delegationId !== undefined ? { delegationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
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

function parseToolClasses(values: string[]): ToolExecutionClass[] {
  const out: ToolExecutionClass[] = [];
  for (const value of values) {
    if (
      value === "read_only" ||
      value === "planning_write" ||
      value === "sandboxed_only" ||
      value === "external_side_effect"
    ) {
      out.push(value);
      continue;
    }
    throw new Error(
      `Unsupported tool class '${value}'. Expected read_only|planning_write|sandboxed_only|external_side_effect.`,
    );
  }
  return out;
}

function readOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    throw new Error("Expected a positive integer.");
  }
  return parsed;
}

function readOptionalStoreDriver(value: string | undefined): "auto" | "postgres" | "sqlite" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "auto" || value === "postgres" || value === "sqlite") {
    return value;
  }
  throw new Error(`Unsupported store driver '${value}'. Expected auto|postgres|sqlite.`);
}

function readOptionalApprovalPack(value: string | undefined): "dev" | "ci_bot" | "production" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "dev" || value === "ci_bot" || value === "production") {
    return value;
  }
  throw new Error(`Unsupported approval pack '${value}'. Expected dev|ci_bot|production.`);
}

async function writeJson(targetPath: string, payload: unknown): Promise<void> {
  const absolute = path.resolve(targetPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function resolveFromCwd(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}
