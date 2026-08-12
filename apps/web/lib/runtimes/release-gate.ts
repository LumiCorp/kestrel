import {
  assertHydraRuntimeReleased,
  isHydraRuntimesEnabled as readHydraReleaseGate,
} from "../../../../src/runtimes/HydraReleaseGate";

export type KestrelRuntimeId = "kestrel" | "codex" | "claude";

export function isHydraRuntimesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readHydraReleaseGate(env);
}

export function assertRuntimeReleased(runtimeId: KestrelRuntimeId): void {
  assertHydraRuntimeReleased(runtimeId, process.env);
}
