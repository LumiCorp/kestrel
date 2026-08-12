import type { SessionStore } from "../kestrel/contracts/store.js";
import type { RunnerHost } from "../../cli/runner/RunnerHost.js";
import {
  KestrelChatRuntime,
  createRuntimeFactoryWithStore,
  type KestrelRuntimeEnvironment,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { LocalCoreRuntimeEnvironmentResolver } from "./runtimeEnvironment.js";
import { DesktopAttachmentStore } from "./desktopAttachments.js";
import type { LocalCoreCredentialStore } from "./credentialStore.js";
import { createLocalCoreMcpOAuthProviderFactory } from "./mcpOAuthProvider.js";
import { LocalCoreMicrosoft365Service } from "./microsoft365Service.js";
import { LocalCoreGoogleWorkspaceService } from "./googleWorkspaceService.js";
import { composeHydraRuntime } from "../../cli/runtime/HydraRuntime.js";
import path from "node:path";
import {
  FileCodexRolloutCheckpointStore,
  FileClaudeSessionStore,
  FileRuntimeBindingCorrelationStore,
  FileRuntimeNativeSessionStore,
} from "../runtimes/FileRuntimeStateStore.js";
import { RuntimeBindingReleaseCoordinator } from "../runtimes/RuntimeBindingReleaseCoordinator.js";
import {
  buildRuntimeChildEnvironment,
  fingerprintRuntimeEnvironment,
} from "../runtimes/RuntimeChildEnvironment.js";
import type { RuntimeEnvironmentMap } from "../runtimes/contracts.js";

type RunnerRuntimeFactory = NonNullable<
  ConstructorParameters<typeof RunnerHost>[1]
>;

export interface LocalCoreRunnerRuntimeFactoryOptions {
  runtimeEnvironmentResolver?: LocalCoreRuntimeEnvironmentResolver | undefined;
  homePath?: string | undefined;
  credentialStore?: LocalCoreCredentialStore | undefined;
  configurationGeneration?: number | undefined;
}

/**
 * Binds every profile runtime in one Local Core host to the same Core-owned
 * persistence handle. The host may create and retire profile runtimes, but it
 * cannot close the shared store; Local Core closes that resource at shutdown.
 */
export function createLocalCoreRunnerRuntimeFactory(
  store: SessionStore,
  options: LocalCoreRunnerRuntimeFactoryOptions = {},
): RunnerRuntimeFactory {
  const runtimeEnvironmentResolver = options.runtimeEnvironmentResolver;
  const nativeStateRoot = path.join(
    path.resolve(options.homePath ?? process.cwd()),
    "runtime",
    "native-runtimes",
  );
  const nativeSessionStore = new FileRuntimeNativeSessionStore(nativeStateRoot);
  const claudeSessionStore = new FileClaudeSessionStore(nativeStateRoot);
  const codexCheckpointStore = new FileCodexRolloutCheckpointStore(nativeStateRoot);
  const bindingCorrelationStore = new FileRuntimeBindingCorrelationStore(nativeStateRoot);
  const releaseCoordinator = new RuntimeBindingReleaseCoordinator(
    nativeSessionStore,
    claudeSessionStore,
    codexCheckpointStore,
    bindingCorrelationStore,
  );
  const kestrelRuntimeFactory = createRuntimeFactoryWithStore(store, {
    enableUserTerminals: true,
    enableWorkspaceChanges: true,
    ...(options.homePath !== undefined
      ? {
          resolveAttachments: async (threadId, attachmentIds) =>
            await new DesktopAttachmentStore(options.homePath!).resolve(
              threadId,
              attachmentIds,
            ),
        }
      : {}),
    ...(runtimeEnvironmentResolver !== undefined
      ? {
          resolveEnvironment: (profile) =>
            toKestrelRuntimeEnvironment(
              runtimeEnvironmentResolver.resolve({
                modelProvider: profile.modelProvider ?? "openrouter",
                model: profile.model ?? "",
              }),
              options.credentialStore,
            ),
        }
      : {}),
  });
  const runtimeFactory: RunnerRuntimeFactory = (
    profile,
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
    _onDetachedTurnEvent,
    onInteractionDelivered,
    onNativeSessionEstablished,
  ) => {
    const resolvedRuntimeEnvironment =
      options.runtimeEnvironmentResolver !== undefined &&
      profile.modelProvider !== undefined &&
      profile.model !== undefined
        ? options.runtimeEnvironmentResolver.resolve({
            modelProvider: profile.modelProvider,
            model: profile.model,
          })
        : undefined;
    const kestrel = new KestrelChatRuntime(profile, kestrelRuntimeFactory, {
      onRunLog,
      onProgress,
      onConsole,
      onReasoning,
      onTaskUpdate,
      onRunEvent,
    });
    return composeHydraRuntime({
      profile,
      kestrel,
      callbacks: {
        onRunLog,
        onProgress,
        onConsole,
        onReasoning,
        onRunEvent,
        onInteractionDelivered,
        onNativeSessionEstablished,
      },
      runtimeEnv:
        resolvedRuntimeEnvironment === undefined
          ? {}
          : {
              ...resolvedRuntimeEnvironment.runtimeEnv,
              ...resolvedRuntimeEnvironment.modelEnv,
            },
      nativeSessionStore,
      claudeSessionStore,
      codexCheckpointStore,
      releaseCoordinator,
      resolveRuntimeEnvironment: async () => {
        const selectedEnvironment: RuntimeEnvironmentMap = resolvedRuntimeEnvironment === undefined
          ? {}
          : {
              ...resolvedRuntimeEnvironment.runtimeEnv,
              ...resolvedRuntimeEnvironment.modelEnv,
            };
        const runtimeId = profile.runtimeId === "claude" ? "claude" : "codex";
        const hasManagedCredential = runtimeId === "codex"
          ? Boolean(selectedEnvironment.OPENAI_API_KEY?.trim())
          : Boolean(selectedEnvironment.ANTHROPIC_API_KEY?.trim());
        const nativeLoginRoot = runtimeId === "codex"
          ? selectedEnvironment.CODEX_HOME
          : selectedEnvironment.CLAUDE_CONFIG_DIR;
        const authenticationSource = hasManagedCredential
          ? "profile-credential"
          : "native-login";
        const environmentWithoutConfiguration = buildRuntimeChildEnvironment({
          runtimeId,
          baseEnvironment: process.env,
          runtimeEnvironment: selectedEnvironment,
        });
        const fingerprint = fingerprintRuntimeEnvironment({
          runtimeId,
          environment: environmentWithoutConfiguration,
          scope: [
            profile.id,
            String(options.configurationGeneration ?? 0),
            authenticationSource,
            profile.modelProvider ?? "",
            profile.model ?? "",
          ],
        });
        const configurationDirectory = hasManagedCredential
          ? path.join(
              nativeStateRoot,
              "credentials",
              runtimeId,
              fingerprint,
            )
          : nativeLoginRoot;
        const env = buildRuntimeChildEnvironment({
          runtimeId,
          baseEnvironment: process.env,
          runtimeEnvironment: selectedEnvironment,
          ...(configurationDirectory !== undefined
            ? { configurationDirectory }
            : {}),
        });
        return { env, credentialFingerprint: fingerprint };
      },
    });
  };
  runtimeFactory.releaseRuntimeBinding = async (input) => {
    await releaseCoordinator.release(input);
  };
  return runtimeFactory;
}

function toKestrelRuntimeEnvironment(
  snapshot: ReturnType<LocalCoreRuntimeEnvironmentResolver["resolve"]>,
  credentialStore?: LocalCoreCredentialStore | undefined,
): KestrelRuntimeEnvironment {
  return {
    modelEnv: snapshot.modelEnv as NodeJS.ProcessEnv,
    internetEnv: snapshot.internetEnv as NodeJS.ProcessEnv,
    runtimeEnv: snapshot.runtimeEnv as NodeJS.ProcessEnv,
    mcpEnv: snapshot.mcpEnv as NodeJS.ProcessEnv,
    ...(credentialStore !== undefined
      ? {
          mcpOAuthProviderFactory:
            createLocalCoreMcpOAuthProviderFactory(credentialStore),
          ...(credentialStore.available
            ? {
                microsoft365Service: new LocalCoreMicrosoft365Service({
                  credentialStore,
                }),
                googleWorkspaceService: new LocalCoreGoogleWorkspaceService({
                  credentialStore,
                }),
              }
            : {}),
        }
      : {}),
  };
}
