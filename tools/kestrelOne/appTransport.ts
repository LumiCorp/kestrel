import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext } from "../contracts.js";

export function resolveKestrelOneAppRequest(
  context: SharedToolContext,
  pathname: string,
): { url: URL; authorization: string; viaRelay: boolean } {
  const relayUrl = context.kestrelOne?.appRelayUrl?.trim();
  const relayToken = context.kestrelOne?.appRelayToken?.trim();
  const executionRunId = context.kestrelOne?.executionRunId?.trim();
  if (relayUrl && relayToken && executionRunId) {
    return {
      url: new URL(
        `/internal/apps/${encodeURIComponent(executionRunId)}${normalizePath(pathname)}`,
        relayUrl,
      ),
      authorization: relayToken,
      viaRelay: true,
    };
  }
  const appUrl = context.kestrelOne?.appUrl?.trim();
  const executionTicket = context.kestrelOne?.executionTicket?.trim();
  if (appUrl && executionTicket) {
    return {
      url: new URL(normalizePath(pathname), appUrl),
      authorization: executionTicket,
      viaRelay: false,
    };
  }
  throw createRuntimeFailure(
    "KESTREL_ONE_APP_CONTEXT_MISSING",
    "Hosted App tools require an execution-scoped App transport.",
    {
      subsystem: "tooling",
      classification: "configuration",
      recoverable: true,
    },
  );
}

export function resolveKestrelOneAppProviderTransport(
  context: SharedToolContext,
): { appUrl: string; executionTicket: string } | undefined {
  const relayUrl = context.kestrelOne?.appRelayUrl?.trim();
  const relayToken = context.kestrelOne?.appRelayToken?.trim();
  const executionRunId = context.kestrelOne?.executionRunId?.trim();
  if (relayUrl && relayToken && executionRunId) {
    return {
      appUrl: new URL(
        `/internal/apps/${encodeURIComponent(executionRunId)}/`,
        relayUrl,
      ).toString(),
      executionTicket: relayToken,
    };
  }
  const appUrl = context.kestrelOne?.appUrl?.trim();
  const executionTicket = context.kestrelOne?.executionTicket?.trim();
  return appUrl && executionTicket ? { appUrl, executionTicket } : undefined;
}

function normalizePath(pathname: string) {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}
