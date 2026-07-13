import type { SessionStore } from "../kestrel/contracts/store.js";
import type { RunnerHost } from "../../cli/runner/RunnerHost.js";
import {
  KestrelChatRuntime,
  createRuntimeFactoryWithStore,
} from "../../cli/runtime/KestrelChatRuntime.js";

type RunnerRuntimeFactory = NonNullable<ConstructorParameters<typeof RunnerHost>[1]>;

/**
 * Binds every profile runtime in one Local Core host to the same Core-owned
 * persistence handle. The host may create and retire profile runtimes, but it
 * cannot close the shared store; Local Core closes that resource at shutdown.
 */
export function createLocalCoreRunnerRuntimeFactory(store: SessionStore): RunnerRuntimeFactory {
  const runtimeFactory = createRuntimeFactoryWithStore(store);
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
