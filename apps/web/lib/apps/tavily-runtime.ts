import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import {
  AppRuntimeError,
  authorizeAppRuntime,
  markAppConnectionDegraded,
} from "./runtime";
import {
  TavilyRuntimeError,
  type TavilyRuntimeCapability,
} from "./tavily-contract";

export {
  assertTavilyProxyTarget,
  TAVILY_RUNTIME_CAPABILITIES,
  TavilyRuntimeError,
} from "./tavily-contract";
export type { TavilyRuntimeCapability } from "./tavily-contract";

const LEGACY_ERROR_CODES: Record<string, string> = {
  APP_RUNTIME_CONTEXT_DENIED: "TAVILY_RUNTIME_CONTEXT_DENIED",
  APP_RUNTIME_PROJECT_ACCESS_DENIED: "TAVILY_PROJECT_ACCESS_DENIED",
  APP_RUNTIME_CAPABILITY_DENIED: "TAVILY_CAPABILITY_DENIED",
  APP_RUNTIME_CONNECTION_DENIED: "TAVILY_CONNECTION_DENIED",
  APP_RUNTIME_APPROVAL_REQUIRED: "TAVILY_APPROVAL_REQUIRED",
};

export async function authorizeTavilyRuntime(input: {
  ticket: EnvironmentExecutionTicket;
  capability: TavilyRuntimeCapability;
  approval: "auto" | "confirmed";
}) {
  try {
    const policy = await authorizeAppRuntime({
      ticket: input.ticket,
      appKey: "tavily",
      capabilityKey: input.capability,
      approval: input.approval,
    });
    if (!policy.connectionId) {
      throw new TavilyRuntimeError("TAVILY_CONNECTION_DENIED");
    }
    if (policy.credential?.kind !== "api_key") {
      throw new TavilyRuntimeError("TAVILY_CREDENTIAL_INVALID");
    }
    return {
      projectId: policy.projectId,
      connectionId: policy.connectionId,
      capability: policy.capability,
      credential: policy.credential,
    };
  } catch (error) {
    if (error instanceof TavilyRuntimeError) throw error;
    if (error instanceof AppRuntimeError) {
      throw new TavilyRuntimeError(
        LEGACY_ERROR_CODES[error.code] ?? "TAVILY_RUNTIME_DENIED",
        error.status
      );
    }
    throw error;
  }
}

export async function markTavilyConnectionDegraded(input: {
  organizationId: string;
  environmentId: string;
  connectionId: string;
  failureCode: string;
}) {
  return markAppConnectionDegraded({
    ...input,
    appKey: "tavily",
  });
}
