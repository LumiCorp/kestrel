import { fileURLToPath } from "node:url";

export function resolveRunnerServiceEntrypoint(
  runtimeModuleUrl: string = import.meta.url
): string {
  return fileURLToPath(
    new URL("../../../dist/cli/runner/service.js", runtimeModuleUrl)
  );
}
