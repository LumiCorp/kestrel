import type { SessionStore } from "../kestrel/contracts/store.js";
import type { RunnerHost } from "../../cli/runner/RunnerHost.js";
import {
  KestrelChatRuntime,
  createRuntimeFactoryWithStore,
  type KestrelRuntimeEnvironment,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { LocalCoreRuntimeEnvironmentResolver } from "./runtimeEnvironment.js";

type RunnerRuntimeFactory = NonNullable<ConstructorParameters<typeof RunnerHost>[1]>;

export interface LocalCoreRunnerRuntimeFactoryOptions {
  runtimeEnvironmentResolver?: LocalCoreRuntimeEnvironmentResolver | undefined;
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
  const runtimeFactory = createRuntimeFactoryWithStore(store, {
    enableUserTerminals: true,
    enableWorkspaceChanges: true,
    ...(runtimeEnvironmentResolver !== undefined
      ? {
          resolveEnvironment: (profile) => toKestrelRuntimeEnvironment(
            runtimeEnvironmentResolver.resolve({
              modelProvider: profile.modelProvider ?? "openrouter",
              model: profile.model ?? "",
            }),
          ),
        }
      : {}),
  });
  return (
    profile,
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
  ) => new KestrelChatRuntime(profile, runtimeFactory, {
    onRunLog,
    onProgress,
    onConsole,
    onReasoning,
    onTaskUpdate,
    onRunEvent,
  });
}

function toKestrelRuntimeEnvironment(
  snapshot: ReturnType<LocalCoreRuntimeEnvironmentResolver["resolve"]>,
): KestrelRuntimeEnvironment {
  return {
    modelEnv: snapshot.modelEnv as NodeJS.ProcessEnv,
    internetEnv: snapshot.internetEnv as NodeJS.ProcessEnv,
    runtimeEnv: snapshot.runtimeEnv as NodeJS.ProcessEnv,
    mcpEnv: snapshot.mcpEnv as NodeJS.ProcessEnv,
  };
}
