import type { TuiProfile } from "../contracts.js";
import type { RunnerRuntime } from "../runner/RunnerHost.js";
import { ClaudeRuntimeAdapter } from "../../src/runtimes/claude/ClaudeRuntimeAdapter.js";
import { CodexRuntimeAdapter } from "../../src/runtimes/codex/CodexRuntimeAdapter.js";
import type { RuntimeAdapterCallbacksV1 } from "../../src/runtimes/contracts.js";
import type {
  RuntimeEnvironmentResolver,
  RuntimeEnvironmentMap,
  RuntimeNativeSessionStore,
} from "../../src/runtimes/contracts.js";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { runtimeIdOrDefault } from "../../src/runtimes/contracts.js";
import { RuntimeAdapterChatRuntime } from "../../src/runtimes/RuntimeAdapterChatRuntime.js";

export function composeHydraRuntime(input: {
  profile: TuiProfile;
  kestrel: RunnerRuntime;
  callbacks?: RuntimeAdapterCallbacksV1 | undefined;
  runtimeEnv?: RuntimeEnvironmentMap | undefined;
  nativeSessionStore?: RuntimeNativeSessionStore | undefined;
  claudeSessionStore?: SessionStore | undefined;
  resolveRuntimeEnvironment?: RuntimeEnvironmentResolver | undefined;
}): RunnerRuntime {
  const runtimeId = runtimeIdOrDefault(input.profile.runtimeId);
  if (runtimeId === "kestrel") {
    return new Proxy(input.kestrel, {
      get(target, property, receiver) {
        if (property === "describeRuntime") return async () => kestrelDescriptor();
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  const adapter =
    runtimeId === "codex"
      ? new CodexRuntimeAdapter(
          input.profile,
          input.callbacks,
          input.runtimeEnv,
          input.nativeSessionStore,
          input.resolveRuntimeEnvironment,
        )
      : new ClaudeRuntimeAdapter(
          input.profile,
          input.callbacks,
          input.runtimeEnv,
          input.nativeSessionStore,
          input.claudeSessionStore,
          input.resolveRuntimeEnvironment,
        );
  const execution = new RuntimeAdapterChatRuntime(runtimeId, adapter);

  return new Proxy(input.kestrel, {
    get(target, property, receiver) {
      if (property === "describeRuntime") {
        return execution.describeRuntime.bind(execution);
      }
      if (property === "runTurn") return execution.runTurn.bind(execution);
      if (property === "cancelActiveRun") {
        return execution.cancelActiveRun.bind(execution);
      }
      if (property === "releaseRuntimeBinding") {
        return execution.releaseRuntimeBinding.bind(execution);
      }
      if (property === "recoverOrphanedActiveRun") return undefined;
      if (property === "close") {
        return async () => {
          await Promise.allSettled([execution.close(), target.close()]);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function kestrelDescriptor() {
  return {
    version: "runtime_descriptor_v1" as const,
    runtimeId: "kestrel" as const,
    displayName: "Kestrel",
    adapterContractVersion: 1 as const,
    nativeVersion: "0.7.0",
    availability: "ready" as const,
    interactionStrategies: ["deferred_session" as const],
    capabilities: {
      modes: ["chat", "plan", "build"] as Array<"chat" | "plan" | "build">,
      continuation: true,
      cancellation: true,
      usage: true,
      attachments: ["image", "text"] as Array<"image" | "text">,
      conversationPersistence: "native_resume" as const,
      interactionRecovery: "durable_resume" as const,
    },
  };
}
