export type KestrelRuntimeId = "kestrel" | "codex" | "claude";

export type HydraReleaseEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function isHydraRuntimesEnabled(
  env: HydraReleaseEnvironment = process.env,
): boolean {
  return env.KESTREL_HYDRA_RUNTIMES_ENABLED === "1";
}

export function assertRuntimeReleased(
  runtimeId: KestrelRuntimeId,
  env: HydraReleaseEnvironment = process.env,
): void {
  if (runtimeId === "kestrel" || isHydraRuntimesEnabled(env)) {
    return;
  }
  throw Object.assign(
    new Error("The selected Runtime is not enabled for this release."),
    { code: "RUNTIME_RELEASE_DISABLED" },
  );
}
