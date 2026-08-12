import type { RuntimeId } from "./contracts.js";

export function isHydraRuntimesEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.KESTREL_HYDRA_RUNTIMES_ENABLED === "1";
}

export function assertHydraRuntimeReleased(
  runtimeId: RuntimeId,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (runtimeId === "kestrel" || isHydraRuntimesEnabled(env)) return;
  throw Object.assign(
    new Error("The selected Runtime is not enabled for this release."),
    { code: "RUNTIME_RELEASE_DISABLED" },
  );
}
