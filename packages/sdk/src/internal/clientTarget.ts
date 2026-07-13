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
  if (options.target !== undefined) {
    if (
      options.baseUrl !== undefined ||
      options.authToken !== undefined ||
      options.fetchImpl !== undefined
    ) {
      throw new KestrelConfigurationError(
        "KestrelClient target cannot be combined with legacy baseUrl, authToken, or fetchImpl options.",
      );
    }
    if (options.target.kind === "local") {
      if (runtime.isNode === false) {
        throw new KestrelConfigurationError(
          "KestrelClient local targets require a Node.js server runtime.",
        );
      }
      return {
        kind: "local",
        socketPath: requireNonEmptyString(options.target.socketPath, "target.socketPath"),
        authToken: requireNonEmptyString(options.target.authToken, "target.authToken"),
      };
    }
    return {
      kind: "remote",
      baseUrl: requireNonEmptyString(options.target.baseUrl, "target.baseUrl"),
      ...(options.target.authToken !== undefined
        ? { authToken: requireNonEmptyString(options.target.authToken, "target.authToken") }
        : {}),
      fetchImpl: options.target.fetchImpl ?? fetch,
    };
  }

  return {
    kind: "remote",
    baseUrl: options.baseUrl === undefined
      ? resolveBaseUrlFromEnv()
      : requireNonEmptyString(options.baseUrl, "baseUrl"),
    ...(options.authToken !== undefined
      ? { authToken: requireNonEmptyString(options.authToken, "authToken") }
      : {}),
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

function resolveBaseUrlFromEnv(): string {
  const baseUrl = process.env.KESTREL_RUNNER_SERVICE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new KestrelConfigurationError(
      "KestrelClient requires target, baseUrl, or KESTREL_RUNNER_SERVICE_URL.",
    );
  }
  return baseUrl;
}

function requireNonEmptyString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new KestrelConfigurationError(`KestrelClient ${field} must be a non-empty string.`);
  }
  return value;
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}
