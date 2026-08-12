import type {
  KestrelClientOptions,
  KestrelLocalTarget,
  KestrelRemoteTarget,
} from "../contracts.js";
import { KestrelConfigurationError } from "../errors.js";

export type ResolvedRemoteTarget = KestrelRemoteTarget & {
  fetchImpl: typeof fetch;
};

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
  if (target.authToken !== undefined && target.authTokenProvider !== undefined) {
    throw new KestrelConfigurationError(
      "KestrelClient remote targets accept authToken or authTokenProvider, not both.",
    );
  }
  if (
    target.authTokenProvider !== undefined &&
    typeof target.authTokenProvider !== "function"
  ) {
    throw new KestrelConfigurationError(
      "KestrelClient target.authTokenProvider must be a function.",
    );
  }
  const resolvedBase = {
    kind: "remote",
    baseUrl: requireNonEmptyString(target.baseUrl, "target.baseUrl"),
    ...(target.onTransportEvent !== undefined
      ? { onTransportEvent: target.onTransportEvent }
      : {}),
    fetchImpl: target.fetchImpl ?? fetch,
  } as const;
  if (target.authTokenProvider !== undefined) {
    return { ...resolvedBase, authTokenProvider: target.authTokenProvider };
  }
  if (target.authToken !== undefined) {
    return {
      ...resolvedBase,
      authToken: requireNonEmptyString(target.authToken, "target.authToken"),
    };
  }
  return resolvedBase;
}

export async function resolveRemoteAuthToken(
  target: ResolvedRemoteTarget,
): Promise<string | undefined> {
  const token = target.authTokenProvider !== undefined
    ? await target.authTokenProvider()
    : target.authToken;
  if (token === undefined) return;
  return requireNonEmptyString(token, "target authorization");
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
