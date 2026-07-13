import type { ProtocolTransport } from "./ProtocolClient.js";
import { LocalCoreRunnerTransport } from "./LocalCoreRunnerTransport.js";
import { RemoteRunnerTransport } from "./RemoteRunnerTransport.js";

export function createConfiguredRunnerTransport(
  env: NodeJS.ProcessEnv = process.env,
): ProtocolTransport {
  const baseUrl = normalizeString(env.KESTREL_RUNNER_SERVICE_URL);
  if (baseUrl !== undefined && baseUrl.length > 0) {
    return new RemoteRunnerTransport({
      baseUrl,
      authToken: normalizeString(env.KESTREL_RUNNER_SERVICE_TOKEN),
    });
  }

  const socketPath = normalizeString(env.KESTREL_LOCAL_CORE_API_SOCKET);
  const authToken = normalizeString(env.KESTREL_LOCAL_CORE_API_TOKEN);
  if (socketPath !== undefined && authToken !== undefined) {
    return new LocalCoreRunnerTransport({ socketPath, authToken });
  }
  if (socketPath !== undefined || authToken !== undefined) {
    throw new Error(
      "Local Core execution transport requires both KESTREL_LOCAL_CORE_API_SOCKET and KESTREL_LOCAL_CORE_API_TOKEN.",
    );
  }
  throw new Error(
    "Local Core execution transport is unavailable. Start Local Core before creating a CLI protocol client.",
  );
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
