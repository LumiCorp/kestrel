import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseRunnerEventV2,
  type RunnerEvent,
  type RunnerTurnInput,
} from "@kestrel-agents/protocol";
import {
  LocalCoreClient,
  startLocalCoreApiServer,
  type LocalCoreRuntimeBindingResponse,
} from "../src/localCore/index.js";
import {
  CANCELLATION_PROMPT,
  continuityPrompt,
  firstTurnPrompt,
  INTERACTION_PROMPT,
} from "./hydra-smoke-prompts.js";
import type {
  HydraRuntimeEvidence,
  HydraRuntimeId,
  HydraScenarioEvidence,
} from "./hydra-smoke-contract.js";
import { HYDRA_LOCAL_SCENARIOS } from "./hydra-smoke-contract.js";

const DESCRIPTOR_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const MATRIX_TIMEOUT_MS = 30 * 60_000;
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

export async function runHydraLocalSmoke(input: {
  sourceSha: string;
  rootPath?: string | undefined;
}): Promise<{ status: "passed" | "failed"; runtimes: HydraRuntimeEvidence[] }> {
  const temporary = input.rootPath ??
    (await mkdtemp(path.join(os.tmpdir(), "kestrel-hydra-smoke-")));
  const removeTemporary = input.rootPath === undefined;
  const coreProductRoot = path.join(temporary, "local-core");
  const coreEnvironment = {
    ...process.env,
    KESTREL_CORE_HOME: coreProductRoot,
    ...(process.env.KESTREL_HYDRA_CODEX_HOME
      ? { CODEX_HOME: process.env.KESTREL_HYDRA_CODEX_HOME }
      : {}),
    ...(process.env.KESTREL_HYDRA_CLAUDE_CONFIG_DIR
      ? { CLAUDE_CONFIG_DIR: process.env.KESTREL_HYDRA_CLAUDE_CONFIG_DIR }
      : {}),
  };
  let server: Awaited<ReturnType<typeof startLocalCoreApiServer>> | undefined;
  let client: LocalCoreClient | undefined;
  const start = async () => {
    server = await startLocalCoreApiServer({
      env: coreEnvironment,
      platform: process.platform,
      coreVersion: "0.8.0",
      idleTimeoutMs: 0,
    });
    client = new LocalCoreClient({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: TURN_TIMEOUT_MS,
    });
  };
  const restart = async () => {
    await server?.close();
    server = undefined;
    client = undefined;
    await start();
  };
  const currentClient = () => {
    assert.ok(client, "Hydra Local Core client is unavailable.");
    return client;
  };
  try {
    await start();
    try {
      return await deadline(
        (async () => {
          const runtimes = [
            await runRuntime("codex", temporary, currentClient, restart),
            await runRuntime("claude", temporary, currentClient, restart),
          ];
          return {
            status: runtimes.every(runtimePassed) ? "passed" as const : "failed" as const,
            runtimes,
          };
        })(),
        MATRIX_TIMEOUT_MS,
        "Hydra local matrix timed out",
      );
    } finally {
      await server?.close();
    }
  } finally {
    if (removeTemporary && process.env.KESTREL_HYDRA_SMOKE_KEEP_STATE !== "1") {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function runRuntime(
  runtimeId: HydraRuntimeId,
  rootPath: string,
  currentClient: () => LocalCoreClient,
  restartLocalCore: () => Promise<void>,
): Promise<HydraRuntimeEvidence> {
  const modelId = requiredEnvironment(
    runtimeId === "codex" ? "KESTREL_HYDRA_CODEX_MODEL" : "KESTREL_HYDRA_CLAUDE_MODEL",
  );
  const runtimeRoot = path.join(rootPath, runtimeId);
  const workspaceRoot = path.join(runtimeRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const authenticationSource = hasProviderCredential(runtimeId)
    ? "profile-credential" as const
    : "native-login" as const;
  let profileId = "";
  const canonicalThreadId = `thread-${runtimeId}-${randomUUID()}`;
  const runnerSessionId = `session-${runtimeId}-${randomUUID()}`;
  let binding: LocalCoreRuntimeBindingResponse | undefined;
  const scenarios: HydraScenarioEvidence[] = [];
  const approvedNativeRoot = runtimeId === "codex"
    ? process.env.KESTREL_HYDRA_CODEX_HOME ?? process.env.CODEX_HOME
    : process.env.KESTREL_HYDRA_CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  if (authenticationSource === "native-login" && !approvedNativeRoot) {
    throw new Error(`Approved ${runtimeId} native login directory is required.`);
  }
  let nativeVersion = "unknown";
  let blocked = false;
  const record = async (id: string, action: () => Promise<void>) => {
    const started = Date.now();
    if (blocked) {
      scenarios.push({
        id,
        status: "failed",
        durationMs: 0,
        failureCode: "HYDRA_SCENARIO_PREREQUISITE_FAILED",
      });
      return false;
    }
    try {
      await action();
      scenarios.push({ id, status: "passed", durationMs: Date.now() - started });
    } catch (error) {
      scenarios.push({
        id,
        status: "failed",
        durationMs: Date.now() - started,
        failureCode: errorCode(error),
      });
      blocked = true;
      return false;
    }
    return true;
  };
  await record("descriptor", async () => {
      const environmentId = await currentClient().runtimeEnvironmentIdentity();
      const resolution = await deadline(
        describeThroughLocalCore(currentClient(), runtimeId, modelId),
        DESCRIPTOR_TIMEOUT_MS,
        "Descriptor timed out",
      );
      const descriptor = resolution.descriptor;
      assert.equal(descriptor.availability, "ready", descriptor.unavailableReason);
      assert.equal(descriptor.runtimeId, runtimeId);
      assert.deepEqual(descriptor.capabilities.attachments, ["text", "image"]);
      assert.equal(descriptor.capabilities.conversationPersistence, "native_resume");
      assert.equal(descriptor.capabilities.interactionRecovery, "connection_bound");
      nativeVersion = descriptor.nativeVersion;
      const resolvedProfile = await resolveExecutionProfileDetails(
        currentClient(),
        runtimeId,
        modelId,
      );
      profileId = resolvedProfile.profileId;
      binding = await currentClient().admitRuntimeBinding({
        canonicalThreadId,
        runnerSessionId,
        runtimeId,
        capabilityDigest: resolution.capabilityDigest,
        modelProvider: resolvedProfile.modelProvider,
        modelId: resolvedProfile.modelId,
        environmentId,
      });
  });
  const nonce = `HYDRA_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  await record("first-turn-attachments", async () => {
      const activeBinding = requireBinding(binding);
      const text = "Hydra authenticated smoke text attachment.";
      const execution = await execute(currentClient(), profileId, activeBinding, {
        sessionId: activeBinding.runnerSessionId,
        runtimeId,
        runId: randomUUID(),
        eventType: "user.message",
        message: firstTurnPrompt(nonce),
        interactionMode: "chat",
        workspace: { workspaceId: "hydra-smoke", workspaceRoot },
        attachments: [
          {
            attachmentId: randomUUID(), threadId: activeBinding.runnerSessionId, filename: "hydra.txt",
            mimeType: "text/plain", kind: "text", text,
            sizeBytes: Buffer.byteLength(text), sha256: digest(Buffer.from(text)),
          },
          {
            attachmentId: randomUUID(), threadId: activeBinding.runnerSessionId, filename: "hydra.png",
            mimeType: "image/png", kind: "image", data: ONE_PIXEL_PNG.toString("base64"),
            sizeBytes: ONE_PIXEL_PNG.length, sha256: digest(ONE_PIXEL_PNG),
          },
        ],
      });
      assertCompleted(execution);
      assert.ok(
        execution.events.some((event) => event.type === "run.native_session.established"),
        "First Turn did not establish durable native session state.",
      );
      binding = await currentClient().getRuntimeBinding(canonicalThreadId);
      assert.equal(binding?.nativeSessionState, "ready");
  });
  await record("ordinary-resume", async () => {
      const activeBinding = requireBinding(binding);
      const result = await execute(currentClient(), profileId, activeBinding, ordinaryTurn(activeBinding, continuityPrompt(), workspaceRoot));
      assertCompleted(result);
      assert.match(result.assistantText, new RegExp(`CONTINUITY_OK:${nonce}`, "u"));
  });
  await record("native-interaction", async () => {
      const activeBinding = requireBinding(binding);
      const waiting = await execute(currentClient(), profileId, activeBinding, {
        ...ordinaryTurn(activeBinding, INTERACTION_PROMPT, workspaceRoot),
        interactionMode: "build",
      });
      assert.equal(waiting.outputStatus, "WAITING", "Native interaction was not requested");
      const interaction = waiting.interaction;
      assert.ok(interaction, "Native interaction is missing");
      const answers = interaction.inputSchema && typeof interaction.inputSchema === "object"
        ? buildFirstSchemaAnswer(interaction.inputSchema as Record<string, unknown>)
        : undefined;
      const continued = await execute(currentClient(), profileId, activeBinding, {
        ...ordinaryTurn(activeBinding, "Approved", workspaceRoot),
        resumeBlockedRun: true,
        resumeRequestId: interaction.requestId,
        interactionResponse: {
          requestId: interaction.requestId,
          eventType: "runtime.interaction.response",
          message: "Approved",
          approved: true,
          ...(answers ? { answers } : {}),
        },
      });
      assertCompleted(continued);
      assert.ok(
        continued.events.some((event) =>
          event.type === "run.interaction.delivered" &&
          event.payload.requestId === interaction.requestId
        ),
        "Native interaction continuation lacked delivery acknowledgement.",
      );
  });
  await record("cancellation", async () => {
      const activeBinding = requireBinding(binding);
      const turn = ordinaryTurn(activeBinding, CANCELLATION_PROMPT, workspaceRoot);
      const started = deferred<void>();
      const pending = execute(
        currentClient(),
        profileId,
        activeBinding,
        { ...turn, interactionMode: "build" },
        (event) => {
          if (event.type === "run.started") started.resolve();
        },
      );
      await deadline(started.promise, TURN_TIMEOUT_MS, "Cancellation Turn did not start");
      await cancelThroughLocalCore(currentClient(), activeBinding.runnerSessionId, turn.runId!);
      const result = await pending;
      assert.equal(result.terminalType, "run.cancelled");
      assert.equal(result.outputStatus, "ABORTED");
  });
  await record("process-restart-resume", async () => {
      await restartLocalCore();
      profileId = await resolveExecutionProfile(currentClient(), runtimeId, modelId);
      binding = await currentClient().getRuntimeBinding(canonicalThreadId);
      const activeBinding = requireBinding(binding);
      assertCompleted(await execute(currentClient(), profileId, activeBinding, ordinaryTurn(activeBinding, "Reply exactly RESTART_OK", workspaceRoot)));
  });
  await record("configuration-generation-rotation", async () => {
      const settings = await currentClient().desktopSettings();
      await currentClient().patchDesktopSettings({ modelPolicy: settings.modelPolicy });
      profileId = await resolveExecutionProfile(currentClient(), runtimeId, modelId);
      binding = await currentClient().getRuntimeBinding(canonicalThreadId);
      const activeBinding = requireBinding(binding);
      assertCompleted(await execute(currentClient(), profileId, activeBinding, ordinaryTurn(activeBinding, "Reply exactly ROTATION_OK", workspaceRoot)));
  });
  await record("missing-native-session", async () => {
      const activeBinding = requireBinding(binding);
      await currentClient().removeRuntimeNativeSessionForSmoke({
        canonicalThreadId: activeBinding.canonicalThreadId,
        bindingId: activeBinding.bindingId,
        participantId: activeBinding.participantId,
        runtimeId: activeBinding.runtimeId,
        environmentId: activeBinding.environmentId,
      });
      const result = await execute(currentClient(), profileId, activeBinding, ordinaryTurn(activeBinding, "This must fail closed", workspaceRoot));
      assert.equal(result.terminalType, "run.failed");
      assert.equal(result.failureCode, "RUNTIME_NATIVE_SESSION_LOST");
  });
  return { runtimeId, nativeVersion, modelId, authenticationSource, scenarios };
}

function ordinaryTurn(binding: LocalCoreRuntimeBindingResponse, message: string, workspaceRoot: string): RunnerTurnInput {
  return {
    sessionId: binding.runnerSessionId,
    runtimeId: binding.runtimeId,
    runId: randomUUID(),
    runtimeBindingId: binding.bindingId,
    runtimeBindingStatus: binding.status,
    runtimeNativeSessionState: binding.nativeSessionState,
    participantId: binding.participantId,
    eventType: "user.message",
    message,
    interactionMode: "chat",
    workspace: { workspaceId: "hydra-smoke", workspaceRoot },
  };
}

interface RunnerExecutionResult {
  events: RunnerEvent[];
  terminalType: "run.completed" | "run.failed" | "run.cancelled";
  outputStatus: string;
  assistantText: string;
  failureCode?: string | undefined;
  interaction?: {
    requestId: string;
    inputSchema?: unknown;
  } | undefined;
}

async function execute(
  client: LocalCoreClient,
  profileId: string,
  binding: LocalCoreRuntimeBindingResponse,
  turn: RunnerTurnInput,
  onEvent?: ((event: RunnerEvent) => void) | undefined,
): Promise<RunnerExecutionResult> {
  const commandId = randomUUID();
  const events: RunnerEvent[] = [];
  await deadline(
    client.sendRunnerCommand(
      JSON.stringify({
        version: "runner_command_v2",
        id: commandId,
        type: "run.start",
        payload: {
          profileId,
          turn: {
            ...turn,
            runtimeBindingId: binding.bindingId,
            runtimeBindingStatus: binding.status,
            runtimeNativeSessionState: binding.nativeSessionState,
            participantId: binding.participantId,
          },
        },
        metadata: smokeMetadata(),
      }),
      {
        onLine(line) {
          const event = parseRunnerEventV2(JSON.parse(line) as unknown);
          assert.equal(event.commandId, commandId);
          events.push(event);
          onEvent?.(event);
        },
      },
    ),
    TURN_TIMEOUT_MS,
    "Runtime Turn timed out",
  );
  const terminal = [...events].reverse().find((event) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
  assert.ok(terminal, "Runner stream did not contain a terminal event.");
  const payload = terminal.payload as unknown as Record<string, unknown>;
  const result = requireRecord(payload.result, "terminal result");
  const output = requireRecord(result.output, "terminal result output");
  const waitFor = optionalRecord(output.waitFor);
  const interaction = optionalRecord(waitFor?.interaction);
  const error = optionalRecord(payload.error);
  return {
    events,
    terminalType: terminal.type,
    outputStatus: String(output.status ?? ""),
    assistantText: typeof result.assistantText === "string" ? result.assistantText : "",
    ...(typeof error?.code === "string" ? { failureCode: error.code } : {}),
    ...(interaction && typeof interaction.requestId === "string"
      ? {
          interaction: {
            requestId: interaction.requestId,
            ...(interaction.inputSchema !== undefined
              ? { inputSchema: interaction.inputSchema }
              : {}),
          },
        }
      : {}),
  };
}

async function cancelThroughLocalCore(
  client: LocalCoreClient,
  sessionId: string,
  runId: string,
): Promise<void> {
  const commandId = randomUUID();
  let acknowledged = false;
  await client.sendRunnerCommand(
    JSON.stringify({
      version: "runner_command_v2",
      id: commandId,
      type: "run.cancel",
      payload: { sessionId, runId },
      metadata: smokeMetadata(),
    }),
    {
      onLine(line) {
        const event = parseRunnerEventV2(JSON.parse(line) as unknown);
        assert.equal(event.commandId, commandId);
        if (event.type === "run.cancelled") acknowledged = true;
      },
    },
  );
  assert.equal(acknowledged, true, "Local Core did not acknowledge run.cancel.");
}

function assertCompleted(result: RunnerExecutionResult): void {
  assert.equal(result.terminalType, "run.completed", result.failureCode);
  assert.equal(result.outputStatus, "COMPLETED", result.failureCode);
}

function buildFirstSchemaAnswer(schema: Record<string, unknown>): Record<string, string[]> | undefined {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return;
  const answer: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const choices = (value as Record<string, unknown>).items;
    const enumValues = typeof choices === "object" && choices !== null && !Array.isArray(choices)
      ? (choices as Record<string, unknown>).enum
      : undefined;
    answer[id] = [Array.isArray(enumValues) && typeof enumValues[0] === "string" ? enumValues[0] : "Approved"];
  }
  return Object.keys(answer).length > 0 ? answer : undefined;
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "HYDRA_SMOKE_TIMEOUT" })), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasProviderCredential(runtimeId: HydraRuntimeId): boolean {
  return Boolean((runtimeId === "codex" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY)?.trim());
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)) return error.code;
  return "HYDRA_SMOKE_SCENARIO_FAILED";
}

function runtimePassed(runtime: HydraRuntimeEvidence): boolean {
  return runtime.scenarios.every((scenario) => scenario.status === "passed") &&
    runtime.scenarios.map((scenario) => scenario.id).every(
      (id, index) => id === HYDRA_LOCAL_SCENARIOS[index],
    ) && runtime.scenarios.length === HYDRA_LOCAL_SCENARIOS.length;
}

async function describeThroughLocalCore(
  client: LocalCoreClient,
  runtimeId: HydraRuntimeId,
  modelId: string,
) {
  return await client.describeRuntime({
    client: "web",
    runtimeId,
    modelProvider: runtimeId === "codex" ? "openai" : "anthropic",
    model: modelId,
    environmentId: await client.runtimeEnvironmentIdentity(),
  });
}

async function resolveExecutionProfile(
  client: LocalCoreClient,
  runtimeId: HydraRuntimeId,
  modelId: string,
): Promise<string> {
  return (await resolveExecutionProfileDetails(client, runtimeId, modelId)).profileId;
}

async function resolveExecutionProfileDetails(
  client: LocalCoreClient,
  runtimeId: HydraRuntimeId,
  modelId: string,
): Promise<{ profileId: string; modelProvider: string; modelId: string }> {
  const commandId = randomUUID();
  let resolved:
    | { profileId: string; modelProvider: string; modelId: string }
    | undefined;
  await client.sendRunnerCommand(
    JSON.stringify({
      version: "runner_command_v2",
      id: commandId,
      type: "execution-profile.resolve",
      payload: {
        environmentPresetId: "desktop_dev_local",
        managedConfiguration: {
          runtimeId,
          modelProvider: runtimeId === "codex" ? "openai" : "anthropic",
          model: modelId,
        },
      },
      metadata: smokeMetadata(),
    }),
    {
      onLine(line) {
        const event = parseRunnerEventV2(JSON.parse(line) as unknown);
        if (event.type === "execution-profile.resolved" && event.commandId === commandId) {
          const modelProvider = event.payload.resolvedProfile.modelProvider;
          const resolvedModelId = event.payload.resolvedProfile.model;
          assert.ok(modelProvider, "Resolved Hydra profile is missing its provider.");
          assert.ok(resolvedModelId, "Resolved Hydra profile is missing its model.");
          resolved = {
            profileId: event.payload.profileId,
            modelProvider,
            modelId: resolvedModelId,
          };
        }
      },
    },
  );
  assert.ok(resolved, "Local Core did not register the Hydra execution profile.");
  return resolved;
}

function requireBinding(
  binding: LocalCoreRuntimeBindingResponse | undefined,
): LocalCoreRuntimeBindingResponse {
  assert.ok(binding, "Local Core did not persist the Hydra Runtime binding.");
  return binding;
}

function smokeMetadata() {
  return {
    tenantId: "hydra-smoke-local",
    actor: {
      actorId: "hydra-release-operator",
      actorType: "operator" as const,
      tenantId: "hydra-smoke-local",
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} is invalid.`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
