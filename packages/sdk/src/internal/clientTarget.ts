import type {
  KestrelClientOptions,
  KestrelLocalTarget,
  KestrelRemoteTarget,
} from "../contracts.js";
import { KestrelConfigurationError } from "../errors.js";

export interface ResolvedRemoteTarget extends KestrelRemoteTarget {
  fetchImpl: typeof fetch;
}

export type ResolvedClientTarget = ResolvedRemoteTarget | KestrelLocalTarget;

export function resolveClientTarget(
  options: KestrelClientOptions,
  runtime: { isNode: boolean } = { isNode: isNodeRuntime() },
): ResolvedClientTarget {
  if (
    typeof options === "object" &&
    options !== null &&
    ("baseUrl" in options || "authToken" in options || "fetchImpl" in options)
  ) {
    throw new KestrelConfigurationError(
      "KestrelClient no longer accepts top-level baseUrl, authToken, or fetchImpl options; set them on an explicit target.",
    );
  }
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.target !== "object" ||
    options.target === null
  ) {
    throw new KestrelConfigurationError(
      "KestrelClient requires an explicit local or remote target.",
    );
  }
  const target = options.target;
  if (target.kind === "local") {
    if (runtime.isNode === false) {
      throw new KestrelConfigurationError(
        "KestrelClient local targets require a Node.js server runtime.",
      );
    }
    return {
      kind: "local",
      socketPath: requireNonEmptyString(target.socketPath, "target.socketPath"),
      authToken: requireNonEmptyString(target.authToken, "target.authToken"),
    };
  }
  if (target.kind !== "remote") {
    throw new KestrelConfigurationError(
      "KestrelClient target.kind must be either local or remote.",
    );
  }
  return {
    kind: "remote",
    baseUrl: requireNonEmptyString(target.baseUrl, "target.baseUrl"),
    ...(target.authToken !== undefined
      ? { authToken: requireNonEmptyString(target.authToken, "target.authToken") }
      : {}),
    fetchImpl: target.fetchImpl ?? fetch,
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new KestrelConfigurationError(`KestrelClient ${field} must be a non-empty string.`);
  }
  return value;
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}
