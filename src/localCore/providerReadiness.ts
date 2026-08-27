import type { ModelProviderId } from "../profile/runtimeProfile.js";

export type LocalCoreManagedCredentialReadiness =
  | {
      ready: true;
      credential: "configured";
    }
  | {
      ready: false;
      credential: "missing" | "unavailable";
    };

export type LocalCoreProviderCredentialReadiness =
  | LocalCoreManagedCredentialReadiness
  | {
      ready: boolean;
      credential: "not_required";
      beta: boolean;
    };

export type LocalCoreProviderReadiness = Record<
  ModelProviderId,
  LocalCoreProviderCredentialReadiness
>;

export interface LocalCoreToolReadiness {
  tavily: LocalCoreManagedCredentialReadiness;
}

export interface LocalCoreProviderReadinessResponse {
  ok: true;
  providerReadiness: LocalCoreProviderReadiness;
  toolReadiness: LocalCoreToolReadiness;
}

const PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
] as const satisfies readonly ModelProviderId[];

export function parseLocalCoreProviderReadinessResponse(
  value: unknown,
): LocalCoreProviderReadinessResponse {
  const response = requireRecord(value, "provider readiness response");
  if (response.ok !== true) {
    throw new Error("Local Core provider readiness response must include ok=true.");
  }
  const rawReadiness = requireRecord(
    response.providerReadiness,
    "provider readiness",
  );
  const providerReadiness = {} as LocalCoreProviderReadiness;

  for (const provider of PROVIDERS) {
    const readiness = requireRecord(
      rawReadiness[provider],
      `provider readiness '${provider}'`,
    );
    if (typeof readiness.ready !== "boolean") {
      throw new Error(
        `Local Core provider readiness '${provider}' must include a boolean ready field.`,
      );
    }
    if (provider === "ollama" || provider === "lmstudio") {
      if (
        readiness.credential !== "not_required"
        || typeof readiness.beta !== "boolean"
      ) {
        throw new Error(
          `Local Core provider readiness '${provider}' is invalid.`,
        );
      }
      providerReadiness[provider] = {
        ready: readiness.ready,
        credential: "not_required",
        beta: readiness.beta,
      };
      continue;
    }
    if (
      readiness.credential !== "configured"
      && readiness.credential !== "missing"
      && readiness.credential !== "unavailable"
    ) {
      throw new Error(
        `Local Core provider readiness '${provider}' credential state is invalid.`,
      );
    }
    if (readiness.ready !== (readiness.credential === "configured")) {
      throw new Error(
        `Local Core provider readiness '${provider}' is inconsistent.`,
      );
    }
    providerReadiness[provider] = readiness.ready
      ? { ready: true, credential: "configured" }
      : {
          ready: false,
          credential: readiness.credential as "missing" | "unavailable",
        };
  }

  const rawToolReadiness = requireRecord(
    response.toolReadiness,
    "tool readiness",
  );
  const tavily = parseManagedCredentialReadiness(
    rawToolReadiness.tavily,
    "tool readiness 'tavily'",
  );

  return {
    ok: true,
    providerReadiness,
    toolReadiness: { tavily },
  };
}

function parseManagedCredentialReadiness(
  value: unknown,
  label: string,
): LocalCoreManagedCredentialReadiness {
  const readiness = requireRecord(value, label);
  if (typeof readiness.ready !== "boolean") {
    throw new Error(`Local Core ${label} must include a boolean ready field.`);
  }
  if (
    readiness.credential !== "configured"
    && readiness.credential !== "missing"
    && readiness.credential !== "unavailable"
  ) {
    throw new Error(`Local Core ${label} credential state is invalid.`);
  }
  if (readiness.ready !== (readiness.credential === "configured")) {
    throw new Error(`Local Core ${label} is inconsistent.`);
  }
  return readiness.ready
    ? { ready: true, credential: "configured" }
    : {
        ready: false,
        credential: readiness.credential as "missing" | "unavailable",
      };
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Local Core ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
